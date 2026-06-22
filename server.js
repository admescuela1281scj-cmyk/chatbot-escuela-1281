require('dotenv').config();
var express = require('express');
var multer = require('multer');
var path = require('path');
var fs = require('fs');
var google = require('googleapis').google;
var TelegramBot = require('node-telegram-bot-api');

var app = express();
var PORT = process.env.PORT || 3000;

var CONFIG = {
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  SHEET_NAME: process.env.SHEET_NAME || 'certificado medico',
  FOLDER_ID: process.env.FOLDER_ID,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  MAX_FILE_SIZE: 10 * 1024 * 1024,
};

var GRADES = [
  'Pre-Jardín', 'Jardín', 'Preparatoria',
  '1er Grado', '2do Grado', '3er Grado',
  '4to Grado', '5to Grado', '6to Grado',
  '7mo Grado', '8vo Grado', '9no Grado'
];

var SHIFTS = ['Mañana', 'Tarde'];
var SECTIONS = ['A', 'B'];

var https = require('https');
var http = require('http');

var auth = null;
try {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    var creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
    });
    console.log('Google Auth desde variable de entorno OK');
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
    });
    console.log('Google Auth desde archivo OK');
  } else {
    console.log('Google Auth NO configurado');
  }
} catch (e) {
  console.log('Error Google Auth:', e.message);
}

var sheets = auth ? google.sheets({ version: 'v4', auth }) : null;
var drive = auth ? google.drive({ version: 'v3', auth }) : null;

var telegramBot = null;
try {
  if (CONFIG.TELEGRAM_BOT_TOKEN) {
    telegramBot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: false });
    console.log('Telegram Bot conectado');
  }
} catch (e) {
  console.log('Error Telegram:', e.message);
}

var conversations = {};
var submissions = [];

var uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

var storage = multer.diskStorage({
  destination: function(_req, _file, cb) { cb(null, uploadDir); },
  filename: function(_req, file, cb) {
    var unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    var ext = path.extname(file.originalname) || '.bin';
    cb(null, 'cert-' + unique + ext);
  },
});

var fileFilter = function(_req, file, cb) {
  var allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
  cb(null, allowed.indexOf(file.mimetype) !== -1);
};

var upload = multer({ storage: storage, fileFilter: fileFilter, limits: { fileSize: CONFIG.MAX_FILE_SIZE } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

app.get('/', function(_req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/chat', upload.single('certificate'), function(req, res) {
  var sessionId = req.body.sessionId || 'default';
  var text = (req.body.message || '').trim();
  var file = req.file || null;

  if (!conversations[sessionId]) {
    conversations[sessionId] = { step: 'welcome', data: {} };
  }

  var conv = conversations[sessionId];
  var response = '';
  var options = null;
  var showUpload = false;
  var showSummary = false;
  var completed = false;
  var completedData = null;

  if (file && conv.step !== 'upload_certificate') {
    conv.data.certificateFile = {
      filename: file.filename, originalname: file.originalname,
      mimetype: file.mimetype, size: file.size, path: file.path,
    };
  }

  switch (conv.step) {
    case 'welcome':
      conv.step = 'name';
      response = '¡Hola! 👋😊 Soy el asistente virtual de la **Escuela Básica N° 1281 Sagrado Corazón de Jesús — Katueté**.\n\nEstoy aquí para ayudarle a registrar la **inasistencia** de su hijo/a.\n\n📝 Solo necesito algunos datos y, si tiene un **certificado médico**, puede adjuntarlo directamente aquí.\n\n¿Cuál es el **nombre completo del estudiante**?';
      break;

    case 'name':
      if (!text || text.split(/\s+/).filter(Boolean).length < 2) {
        response = '😅 Necesito el **nombre y apellido** del estudiante.\n\n*Ejemplo: María López González*';
        break;
      }
      conv.data.studentName = text;
      conv.step = 'grade';
      response = '¡Perfecto, **' + text + '**! 👍\n\nAhora seleccione el **grado** del estudiante:';
      options = GRADES;
      break;

    case 'grade':
      var idx = parseInt(text) - 1;
      var byIndex = !isNaN(idx) && idx >= 0 && idx < GRADES.length;
      var byName = null;
      for (var g = 0; g < GRADES.length; g++) {
        if (GRADES[g].toLowerCase() === text.toLowerCase()) { byName = GRADES[g]; break; }
      }
      if (!byIndex && !byName) {
        response = 'Por favor seleccione un **grado válido** de la lista. 👆';
        options = GRADES;
        break;
      }
      conv.data.grade = byIndex ? GRADES[idx] : byName;
      conv.step = 'shift';
      response = 'Grado: **' + conv.data.grade + '** ✅\n\nSeleccione el **turno**:';
      options = SHIFTS;
      break;

    case 'shift':
      var validShift = null;
      for (var s = 0; s < SHIFTS.length; s++) {
        if (SHIFTS[s].toLowerCase() === text.toLowerCase()) { validShift = SHIFTS[s]; break; }
      }
      if (!validShift) {
        response = 'Seleccione un **turno válido**. 👆';
        options = SHIFTS;
        break;
      }
      conv.data.shift = validShift;
      conv.step = 'section';
      response = 'Turno: **' + validShift + '** ✅\n\nSeleccione la **sección**:';
      options = SECTIONS;
      break;

    case 'section':
      var validSec = null;
      for (var sec = 0; sec < SECTIONS.length; sec++) {
        if (SECTIONS[sec].toLowerCase() === text.toLowerCase()) { validSec = SECTIONS[sec]; break; }
      }
      if (!validSec) {
        response = 'Seleccione una **sección válida** (A o B). 👆';
        options = SECTIONS;
        break;
      }
      conv.data.section = validSec;
      conv.step = 'has_certificate';
      response = 'Sección: **' + validSec + '** ✅\n\n🏥 ¿Cuenta con **certificado médico** para justificar la inasistencia?';
      options = ['✅ Sí, tengo certificado', '❌ No, solo justificación'];
      break;

    case 'has_certificate':
      var lower = text.toLowerCase();
      var hasCert = lower.indexOf('sí') !== -1 || lower.indexOf('si') !== -1 || lower.indexOf('certificado') !== -1;
      var noCert = lower.indexOf('no') !== -1 || lower.indexOf('justificación') !== -1 || lower.indexOf('justificacion') !== -1;
      if (!hasCert && !noCert) {
        response = 'Por favor seleccione una opción: 👆';
        options = ['✅ Sí, tengo certificado', '❌ No, solo justificación'];
        break;
      }
      if (hasCert) {
        conv.data.hasCertificate = true;
        conv.step = 'upload_certificate';
        response = '📄 **Adjunte el certificado médico**\n\nPuede subir una **foto** o **PDF** del certificado.\n\n💡 *Use el botón 📎 de abajo para seleccionar el archivo.*';
        showUpload = true;
      } else {
        conv.data.hasCertificate = false;
        conv.step = 'justification';
        response = '📝 **Escriba la justificación de la inasistencia**\n\nPor favor indique el **motivo** por el cual el estudiante no asistió a clases.\n\n*Ejemplo: "El estudiante presentó fiebre y malestar general"*';
      }
      break;

    case 'upload_certificate':
      if (!file && text) {
        if (conv.data.certificateFile) { conv.step = 'summary'; showSummary = true; response = buildSummary(conv.data); break; }
        response = '📎 Por favor adjunte el **certificado médico** como archivo (foto o PDF).';
        showUpload = true; break;
      }
      if (!file) {
        if (conv.data.certificateFile) { conv.step = 'summary'; showSummary = true; response = buildSummary(conv.data); break; }
        response = '📎 Esperando el **certificado médico**...';
        showUpload = true; break;
      }
      conv.data.certificateFile = { filename: file.filename, originalname: file.originalname, mimetype: file.mimetype, size: file.size, path: file.path };
      conv.step = 'summary'; showSummary = true;
      response = '✅ **¡Archivo recibido!** 📎 *' + file.originalname + '*\n\n' + buildSummary(conv.data);
      break;

    case 'justification':
      if (!text || text.length < 10) { response = '📝 La justificación debe tener al menos **10 caracteres**.'; break; }
      conv.data.justification = text; conv.step = 'summary'; showSummary = true;
      response = buildSummary(conv.data);
      break;

    case 'summary':
      if (conv.data.studentName) {
        saveSubmission(conv.data, sessionId, function(saveResult) {
          completed = true; completedData = saveResult;
          response = '🎉 **¡Registro completado con éxito!**\n\n';
          response += '👤 Estudiante: **' + conv.data.studentName + '**\n';
          response += '📚 Grado: **' + conv.data.grade + '**\n';
          response += '🕐 Turno: **' + conv.data.shift + '**\n';
          response += '🔤 Sección: **' + conv.data.section + '**\n';
          if (conv.data.hasCertificate) { response += '🏥 Certificado: **Sí**\n'; }
          else { response += '📝 Justificación: *' + (conv.data.justification || '') + '*\n'; }
          response += '\n';
          if (saveResult.telegramSent) response += '✅ Notificación enviada por Telegram\n';
          if (saveResult.sheetRow) response += '✅ Registro guardado en Google Sheets\n';
          if (saveResult.fileLink) response += '🔗 Link: ' + saveResult.fileLink + '\n';
          response += '\n🙏 ¡Gracias!\n\n¿Desea registrar **otra inasistencia**?';
          options = ['✅ Sí, registrar otra', '❌ No, gracias'];
          delete conversations[sessionId];
          res.json({ success: true, response: response, sessionId: sessionId, options: options, showUpload: false, showSummary: false, completed: completed, completedData: completedData });
        });
        return;
      }
      response = '¿Desea registrar otra inasistencia?';
      options = ['✅ Sí, registrar otra', '❌ No, gracias'];
      delete conversations[sessionId];
      break;

    default:
      conversations[sessionId] = { step: 'welcome', data: {} };
      response = '¡Bienvenido de nuevo! 👋\n\n¿Cuál es el **nombre completo del estudiante**?';
  }

  res.json({ success: true, response: response, sessionId: sessionId, options: options, showUpload: showUpload, showSummary: showSummary, completed: completed, completedData: completedData });
});

function buildSummary(data) {
  var s = '📋 **RESUMEN DEL REGISTRO**\n';
  s += '━━━━━━━━━━━━━━━━━━━━━━━━\n';
  s += '👤 **Estudiante:** ' + data.studentName + '\n';
  s += '📚 **Grado:** ' + data.grade + '\n';
  s += '🕐 **Turno:** ' + data.shift + '\n';
  s += '🔤 **Sección:** ' + data.section + '\n';
  s += '━━━━━━━━━━━━━━━━━━━━━━━━\n';
  if (data.hasCertificate) { s += '🏥 **Certificado:** ✅ Sí\n'; }
  else { s += '📝 **Certificado:** ❌ No\n💬 **Justificación:** *' + data.justification + '*\n'; }
  s += '━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
  s += '✅ ¿Todo está correcto? **Presione el botón de abajo** para confirmar.';
  return s;
}

function uploadToHost(filePath, callback) {
  try {
    var fileBuffer = fs.readFileSync(filePath);
    var fileName = path.basename(filePath);
    var ext = path.extname(filePath).toLowerCase();
    var mimeTypes = {'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.pdf':'application/pdf'};
    var mime = mimeTypes[ext] || 'application/octet-stream';
    var boundary = '----FB' + Date.now();
    var parts = [];
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + fileName + '"\r\nContent-Type: ' + mime + '\r\n\r\n'));
    parts.push(fileBuffer);
    parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
    var body = Buffer.concat(parts);
    var options = { hostname: '0x0.st', path: '/', method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length } };
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        var url = data.trim();
        if (url.indexOf('https://') === 0) { console.log('Link:', url); callback(url); }
        else { console.log('Upload:', url); callback(null); }
      });
    });
    req.on('error', function(e) { console.log('Err upload:', e.message); callback(null); });
    req.write(body); req.end();
  } catch (e) { console.log('Err upload:', e.message); callback(null); }
}

function saveSubmission(data, sessionId, callback) {
  var result = { id: 'SUB-' + Date.now(), savedAt: new Date().toISOString(), telegramSent: false, sheetRow: null, fileLink: null };

  if (telegramBot && CONFIG.TELEGRAM_CHAT_ID) {
    var msg = '📋 *NUEVA INASISTENCIA REGISTRADA*\n\n';
    msg += '👤 *Estudiante:* ' + data.studentName + '\n';
    msg += '📚 *Grado:* ' + data.grade + '\n';
    msg += '🕐 *Turno:* ' + data.shift + '\n';
    msg += '🔤 *Sección:* ' + data.section + '\n';
    msg += '🏥 *Certificado:* ' + (data.hasCertificate ? '✅ Sí' : '❌ No') + '\n';
    if (data.hasCertificate && data.certificateFile) { msg += '📎 *Archivo:* ' + data.certificateFile.originalname + '\n'; }
    else { msg += '💬 *Justificación:* ' + (data.justification || 'N/A') + '\n'; }
    msg += '📅 *Fecha:* ' + new Date().toLocaleString('es-PY') + '\n';
    msg += '🆔 *ID:* ' + result.id;

    telegramBot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }).then(function() {
      result.telegramSent = true;
      if (data.certificateFile && data.certificateFile.path && fs.existsSync(data.certificateFile.path)) {
        uploadToHost(data.certificateFile.path, function(link) {
          result.fileLink = link;
          var isPdf = data.certificateFile.mimetype === 'application/pdf';
          var caption = '📄 Certificado de ' + data.studentName;
          if (link) caption += '\n🔗 ' + link;
          var p = isPdf ? telegramBot.sendDocument(CONFIG.TELEGRAM_CHAT_ID, data.certificateFile.path, { caption: caption }) : telegramBot.sendPhoto(CONFIG.TELEGRAM_CHAT_ID, data.certificateFile.path, { caption: caption });
          p.then(function() { saveToSheet(data, result, callback); }).catch(function() { saveToSheet(data, result, callback); });
        });
      } else { saveToSheet(data, result, callback); }
    }).catch(function(err) { console.log('Err Telegram:', err.message); saveToSheet(data, result, callback); });
  } else { saveToSheet(data, result, callback); }
}

function saveToSheet(data, result, callback) {
  if (sheets && CONFIG.SPREADSHEET_ID) {
    var certInfo = 'Sin certificado';
    if (data.hasCertificate) { certInfo = result.fileLink || (data.certificateFile ? data.certificateFile.originalname : 'Adjunto'); }
    var row = [ result.id, new Date().toLocaleString('es-PY'), data.studentName, data.grade, data.shift, data.section, certInfo, data.hasCertificate ? 'Con certificado' : 'Justificación escrita', data.hasCertificate ? '' : (data.justification || ''), '' ];
    sheets.spreadsheets.values.append({ spreadsheetId: CONFIG.SPREADSHEET_ID, range: "'" + CONFIG.SHEET_NAME + "'!A:J", valueInputOption: 'USER_ENTERED', resource: { values: [row] } }).then(function(resp) {
      result.sheetRow = 'OK'; console.log('Sheets OK'); callback(result);
    }).catch(function(err) { console.log('ERROR Sheets:', err.message); callback(result); });
  } else { callback(result); }
}

app.listen(PORT, function() {
  console.log('Esc. Basica N1281 - Katuete');
  console.log('Servidor: http://localhost:' + PORT);
});
