require('dotenv').config();
var express = require('express');
var multer = require('multer');
var path = require('path');
var fs = require('fs');
var https = require('https');
var fetch = require('node-fetch');
var google = require('googleapis').google;
var TelegramBot = require('node-telegram-bot-api');
var app = express();
var PORT = process.env.PORT || 3000;
var CONFIG = {
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  SHEET_NAME: process.env.SHEET_NAME || 'certificado medico',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  MAX_FILE_SIZE: 10 * 1024 * 1024,
};
var GRADES = ['Pre-Jardin','Jardin','Preparatoria','1er Grado','2do Grado','3er Grado','4to Grado','5to Grado','6to Grado','7mo Grado','8vo Grado','9no Grado'];
var SHIFTS = ['Manana', 'Tarde'];
var SECTIONS = ['A', 'B'];
var auth = null;
try {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON), scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    console.log('Google Auth OK');
  }
} catch (e) { console.log('Error Auth:', e.message); }
var sheets = auth ? google.sheets({ version: 'v4', auth }) : null;
var telegramBot = null;
try { if (CONFIG.TELEGRAM_BOT_TOKEN) { telegramBot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: false }); console.log('Telegram OK'); } } catch (e) {}
var conversations = {};
var uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
var storage = multer.diskStorage({
  destination: function(r, f, cb) { cb(null, uploadDir); },
  filename: function(r, file, cb) { cb(null, 'cert-' + Date.now() + '-' + Math.round(Math.random() * 1e6) + (path.extname(file.originalname) || '.bin')); }
});
var upload = multer({ storage: storage, fileFilter: function(r, file, cb) { cb(null, ['image/jpeg','image/png','image/webp','image/gif','application/pdf'].indexOf(file.mimetype) !== -1); }, limits: { fileSize: CONFIG.MAX_FILE_SIZE } });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', function(r, res) { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.post('/api/chat', upload.single('certificate'), function(req, res) {
  var sessionId = req.body.sessionId || 'default';
  var text = (req.body.message || '').trim();
  var file = req.file || null;
  if (!conversations[sessionId]) conversations[sessionId] = { step: 'welcome', data: {} };
  var conv = conversations[sessionId];
  var response = '', options = null, showUpload = false, showSummary = false, completed = false, completedData = null;
  if (file && conv.step !== 'upload_certificate') {
    conv.data.certificateFile = { filename: file.filename, originalname: file.originalname, mimetype: file.mimetype, size: file.size, path: file.path };
  }
  switch (conv.step) {
    case 'welcome':
      conv.step = 'name';
      response = 'Hola! Soy el asistente virtual de la Escuela Basica N 1281 Sagrado Corazon de Jesus - Katuete. Estoy aqui para ayudarle a registrar la inasistencia de su hijo/a. Cual es el nombre completo del estudiante?';
      break;
    case 'name':
      if (!text || text.split(/\s+/).filter(Boolean).length < 2) { response = 'Necesito nombre y apellido. Ejemplo: Maria Lopez'; break; }
      conv.data.studentName = text; conv.step = 'grade'; response = 'Perfecto, ' + text + '! Seleccione el grado:'; options = GRADES; break;
    case 'grade':
      var idx = parseInt(text) - 1; var byIdx = !isNaN(idx) && idx >= 0 && idx < GRADES.length; var byNm = null;
      for (var g = 0; g < GRADES.length; g++) { if (GRADES[g].toLowerCase() === text.toLowerCase()) { byNm = GRADES[g]; break; } }
      if (!byIdx && !byNm) { response = 'Seleccione un grado valido.'; options = GRADES; break; }
      conv.data.grade = byIdx ? GRADES[idx] : byNm; conv.step = 'shift'; response = 'Grado: ' + conv.data.grade + '. Seleccione el turno:'; options = SHIFTS; break;
    case 'shift':
      var vs = null; for (var s = 0; s < SHIFTS.length; s++) { if (SHIFTS[s].toLowerCase() === text.toLowerCase()) { vs = SHIFTS[s]; break; } }
      if (!vs) { response = 'Seleccione un turno.'; options = SHIFTS; break; }
      conv.data.shift = vs; conv.step = 'section'; response = 'Turno: ' + vs + '. Seleccione la seccion:'; options = SECTIONS; break;
    case 'section':
      var vsc = null; for (var sc = 0; sc < SECTIONS.length; sc++) { if (SECTIONS[sc].toLowerCase() === text.toLowerCase()) { vsc = SECTIONS[sc]; break; } }
      if (!vsc) { response = 'Seleccione A o B.'; options = SECTIONS; break; }
      conv.data.section = vsc; conv.step = 'has_certificate'; response = 'Seccion: ' + vsc + '. Cuenta con certificado medico?'; options = ['Si, tengo certificado', 'No, solo justificacion']; break;
    case 'has_certificate':
      var lo = text.toLowerCase(); var hc = lo.indexOf('si') !== -1 || lo.indexOf('certificado') !== -1; var nc = lo.indexOf('no') !== -1 || lo.indexOf('justificacion') !== -1;
      if (!hc && !nc) { response = 'Seleccione una opcion:'; options = ['Si, tengo certificado', 'No, solo justificacion']; break; }
      if (hc) { conv.data.hasCertificate = true; conv.step = 'upload_certificate'; response = 'Adjunte el certificado medico (foto o PDF). Use el boton de abajo.'; showUpload = true; }
      else { conv.data.hasCertificate = false; conv.step = 'justification'; response = 'Escriba la justificacion de la inasistencia (minimo 10 caracteres).'; }
      break;
    case 'upload_certificate':
      if (!file && text) { if (conv.data.certificateFile) { conv.step = 'summary'; showSummary = true; response = buildSummary(conv.data); break; } response = 'Adjunte el certificado.'; showUpload = true; break; }
      if (!file) { if (conv.data.certificateFile) { conv.step = 'summary'; showSummary = true; response = buildSummary(conv.data); break; } response = 'Esperando certificado...'; showUpload = true; break; }
      conv.data.certificateFile = { filename: file.filename, originalname: file.originalname, mimetype: file.mimetype, size: file.size, path: file.path };
      conv.step = 'summary'; showSummary = true; response = 'Archivo recibido: ' + file.originalname + '\n\n' + buildSummary(conv.data); break;
    case 'justification':
      if (!text || text.length < 10) { response = 'Minimo 10 caracteres.'; break; }
      conv.data.justification = text; conv.step = 'summary'; showSummary = true; response = buildSummary(conv.data); break;
    case 'summary':
      if (conv.data.studentName) {
        saveSubmission(conv.data, sessionId, function(sr) {
          completed = true; completedData = sr;
          response = 'Registro completado!\n\nEstudiante: ' + conv.data.studentName + '\nGrado: ' + conv.data.grade + '\nTurno: ' + conv.data.shift + '\nSeccion: ' + conv.data.section + '\n';
          if (conv.data.hasCertificate) response += 'Certificado: Si\n'; else response += 'Justificacion: ' + (conv.data.justification || '') + '\n';
          if (sr.telegramSent) response += '\nTelegram OK\n';
          if (sr.sheetRow) response += 'Google Sheets OK\n';
          if (sr.fileLink) response += 'Link: ' + sr.fileLink + '\n';
          response += '\nGracias! Desea registrar otra inasistencia?';
          options = ['Si, registrar otra', 'No, gracias']; delete conversations[sessionId];
          res.json({ success: true, response: response, sessionId: sessionId, options: options, showUpload: false, showSummary: false, completed: true, completedData: sr });
        }); return;
      }
      response = 'Desea registrar otra?'; options = ['Si, registrar otra', 'No, gracias']; delete conversations[sessionId]; break;
    default: conversations[sessionId] = { step: 'welcome', data: {} }; response = 'Bienvenido! Cual es el nombre del estudiante?';
  }
  res.json({ success: true, response: response, sessionId: sessionId, options: options, showUpload: showUpload, showSummary: showSummary, completed: completed, completedData: completedData });
});
function buildSummary(data) {
  var s = 'RESUMEN DEL REGISTRO\nEstudiante: ' + data.studentName + '\nGrado: ' + data.grade + '\nTurno: ' + data.shift + '\nSeccion: ' + data.section + '\n';
  if (data.hasCertificate) s += 'Certificado: Si\n'; else s += 'Certificado: No\nJustificacion: ' + data.justification + '\n';
  s += '\nPresione CONFIRMAR REGISTRO para enviar.'; return s;
}
function saveSubmission(data, sessionId, callback) {
  var result = { id: 'SUB-' + Date.now(), telegramSent: false, sheetRow: null, fileLink: null };
  var driveUrl = 'https://script.google.com/macros/s/AKfycbwACA_antGDuuUvC7JcXko8sxu9HxeaOgocMDrBADhtjPjktIbD3AubJPnv8s5AyLHg/exec';

  if (telegramBot && CONFIG.TELEGRAM_CHAT_ID) {
    var msg = 'NUEVA INASISTENCIA REGISTRADA\n\nEstudiante: ' + data.studentName + '\nGrado: ' + data.grade + '\nTurno: ' + data.shift + '\nSeccion: ' + data.section + '\nCertificado: ' + (data.hasCertificate ? 'Si' : 'No') + '\n';
    if (data.hasCertificate && data.certificateFile) msg += 'Archivo: ' + data.certificateFile.originalname + '\n';
    else msg += 'Justificacion: ' + (data.justification || 'N/A') + '\n';
    msg += 'Fecha: ' + new Date().toLocaleString('es-PY') + '\nID: ' + result.id;

    telegramBot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, msg).then(function() {
      result.telegramSent = true; console.log('Telegram OK');
      if (data.certificateFile && data.certificateFile.path && fs.existsSync(data.certificateFile.path)) {
        try {
          var fileBuffer = fs.readFileSync(data.certificateFile.path);
          var base64 = fileBuffer.toString('base64');
          var postData = 'file=' + encodeURIComponent(base64) + '&fileName=' + encodeURIComponent(data.certificateFile.originalname) + '&mimeType=' + encodeURIComponent(data.certificateFile.mimetype);

          fetch(driveUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: postData,
            redirect: 'follow'
          }).then(function(resp) { return resp.json(); }).then(function(json) {
            if (json.success && json.url) {
              result.fileLink = json.url;
              console.log('Drive OK:', json.url);
            } else {
              console.log('Drive respuesta:', JSON.stringify(json));
            }
            sendTelegramAndSave(data, result, callback);
          }).catch(function(e) {
            console.log('Drive error:', e.message);
            sendTelegramAndSave(data, result, callback);
          });
        } catch(e) { console.log('Drive error:', e.message); sendTelegramAndSave(data, result, callback); }
      } else { sendTelegramAndSave(data, result, callback); }
    }).catch(function(err) { console.log('Err Telegram:', err.message); sendTelegramAndSave(data, result, callback); });
  } else { sendTelegramAndSave(data, result, callback); }
}

function sendTelegramAndSave(data, result, callback) {
  if (telegramBot && CONFIG.TELEGRAM_CHAT_ID && data.certificateFile && data.certificateFile.path && fs.existsSync(data.certificateFile.path)) {
    var isPdf = data.certificateFile.mimetype === 'application/pdf';
    var cap = 'Certificado de ' + data.studentName;
    if (result.fileLink) cap += '\nLink Drive: ' + result.fileLink;
    var p = isPdf ? telegramBot.sendDocument(CONFIG.TELEGRAM_CHAT_ID, data.certificateFile.path, { caption: cap }) : telegramBot.sendPhoto(CONFIG.TELEGRAM_CHAT_ID, data.certificateFile.path, { caption: cap });
    p.then(function() { saveToSheet(data, result, callback); }).catch(function() { saveToSheet(data, result, callback); });
  } else { saveToSheet(data, result, callback); }
}
function saveToSheet(data, result, callback) {
  if (sheets && CONFIG.SPREADSHEET_ID) {
    var certInfo = 'Sin certificado';
    if (data.hasCertificate) certInfo = result.fileLink || (data.certificateFile ? data.certificateFile.originalname : 'Adjunto');
    var row = [result.id, new Date().toLocaleString('es-PY'), data.studentName, data.grade, data.shift, data.section, certInfo, data.hasCertificate ? 'Con certificado' : 'Justificacion escrita', data.hasCertificate ? '' : (data.justification || ''), ''];
    sheets.spreadsheets.values.append({ spreadsheetId: CONFIG.SPREADSHEET_ID, range: "'" + CONFIG.SHEET_NAME + "'!A:J", valueInputOption: 'USER_ENTERED', resource: { values: [row] } }).then(function() {
      result.sheetRow = 'OK'; console.log('Sheets OK'); callback(result);
    }).catch(function(err) { console.log('ERROR Sheets:', err.message); callback(result); });
  } else { callback(result); }
}
app.listen(PORT, function() { console.log('Servidor en puerto ' + PORT); });
