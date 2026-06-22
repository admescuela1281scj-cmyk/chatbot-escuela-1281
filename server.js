require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;

const CONFIG = {
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  SHEET_NAME: process.env.SHEET_NAME || 'certificado medico',
  FOLDER_ID: process.env.FOLDER_ID,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  MAX_FILE_SIZE: 10 * 1024 * 1024,
};

const GRADES = [
  'Pre-Jardin', 'Jardin', 'Preparatoria',
  '1er Grado', '2do Grado', '3er Grado',
  '4to Grado', '5to Grado', '6to Grado',
  '7mo Grado', '8vo Grado', '9no Grado'
];

const SHIFTS = ['Manana', 'Tarde'];
const SECTIONS = ['A', 'B'];

let auth;
try {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
    });
  }
} catch (e) {
  console.warn('Error Google Auth:', e.message);
}

const sheets = auth ? google.sheets({ version: 'v4', auth }) : null;
const drive = auth ? google.drive({ version: 'v3', auth }) : null;

let telegramBot = null;
try {
  if (CONFIG.TELEGRAM_BOT_TOKEN) {
    telegramBot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: false });
    console.log('Telegram Bot conectado');
  }
} catch (e) {
  console.warn('Error Telegram:', e.message);
}

const conversations = {};
const submissions = [];

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function(_req, _file, cb) { cb(null, uploadDir); },
  filename: function(_req, file, cb) {
    var unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    var ext = path.extname(file.originalname) || '.bin';
    cb(null, 'cert-' + unique + ext);
  },
});

const fileFilter = function(_req, file, cb) {
  var allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
  cb(null, allowed.indexOf(file.mimetype) !== -1);
};

const upload = multer({ storage: storage, fileFilter: fileFilter, limits: { fileSize: CONFIG.MAX_FILE_SIZE } });

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
      response = 'Hola! Soy el asistente virtual de la Escuela Basica N 1281 Sagrado Corazon de Jesus - Katuete. Estoy aqui para ayudarle a registrar la inasistencia de su hijo/a. Solo necesito algunos datos y, si tiene un certificado medico, puede adjuntarlo directamente aqui. Cual es el nombre completo del estudiante?';
      break;

    case 'name':
      if (!text || text.split(/\s+/).filter(Boolean).length < 2) {
        response = 'Necesito el nombre y apellido del estudiante. Ejemplo: Maria Lopez Gonzalez';
        break;
      }
      conv.data.studentName = text;
      conv.step = 'grade';
      response = 'Perfecto, ' + text + '! Ahora seleccione el grado del estudiante:';
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
        response = 'Por favor seleccione un grado valido de la lista.';
        options = GRADES;
        break;
      }
      conv.data.grade = byIndex ? GRADES[idx] : byName;
      conv.step = 'shift';
      response = 'Grado: ' + conv.data.grade + '. Seleccione el turno:';
      options = SHIFTS;
      break;

    case 'shift':
      var validShift = null;
      for (var s = 0; s < SHIFTS.length; s++) {
        if (SHIFTS[s].toLowerCase() === text.toLowerCase()) { validShift = SHIFTS[s]; break; }
      }
      if (!validShift) {
        response = 'Seleccione un turno valido.';
        options = SHIFTS;
        break;
      }
      conv.data.shift = validShift;
      conv.step = 'section';
      response = 'Turno: ' + validShift + '. Seleccione la seccion:';
      options = SECTIONS;
      break;

    case 'section':
      var validSec = null;
      for (var sec = 0; sec < SECTIONS.length; sec++) {
        if (SECTIONS[sec].toLowerCase() === text.toLowerCase()) { validSec = SECTIONS[sec]; break; }
      }
      if (!validSec) {
        response = 'Seleccione una seccion valida (A o B).';
        options = SECTIONS;
        break;
      }
      conv.data.section = validSec;
      conv.step = 'has_certificate';
      response = 'Seccion: ' + validSec + '. Cuenta con certificado medico para justificar la inasistencia?';
      options = ['Si, tengo certificado', 'No, solo justificacion'];
      break;

    case 'has_certificate':
      var lower = text.toLowerCase();
      var hasCert = lower.indexOf('si') !== -1 || lower.indexOf('certificado') !== -1;
      var noCert = lower.indexOf('no') !== -1 || lower.indexOf('justificacion') !== -1;
      if (!hasCert && !noCert) {
        response = 'Por favor seleccione una opcion:';
        options = ['Si, tengo certificado', 'No, solo justificacion'];
        break;
      }
      if (hasCert) {
        conv.data.hasCertificate = true;
        conv.step = 'upload_certificate';
        response = 'Adjunte el certificado medico. Puede subir una foto o PDF del certificado. Use el boton de abajo para seleccionar el archivo.';
        showUpload = true;
      } else {
        conv.data.hasCertificate = false;
        conv.step = 'justification';
        response = 'Escriba la justificacion de la inasistencia. Indique el motivo por el cual el estudiante no asistio a clases.';
      }
      break;

    case 'upload_certificate':
      if (!file && text) {
        if (conv.data.certificateFile) {
          conv.step = 'summary';
          showSummary = true;
          response = buildSummary(conv.data);
          break;
        }
        response = 'Por favor adjunte el certificado medico como archivo (foto o PDF).';
        showUpload = true;
        break;
      }
      if (!file) {
        if (conv.data.certificateFile) {
          conv.step = 'summary';
          showSummary = true;
          response = buildSummary(conv.data);
          break;
        }
        response = 'Esperando el certificado medico... Use el boton de abajo para adjuntar.';
        showUpload = true;
        break;
      }
      conv.data.certificateFile = {
        filename: file.filename, originalname: file.originalname,
        mimetype: file.mimetype, size: file.size, path: file.path,
      };
      conv.step = 'summary';
      showSummary = true;
      response = 'Archivo recibido: ' + file.originalname + '\n\n' + buildSummary(conv.data);
      break;

    case 'justification':
      if (!text || text.length < 10) {
        response = 'La justificacion debe tener al menos 10 caracteres. Por favor detalle el motivo.';
        break;
      }
      conv.data.justification = text;
      conv.step = 'summary';
      showSummary = true;
      response = buildSummary(conv.data);
      break;

    case 'summary':
      if (conv.data.studentName) {
        saveSubmission(conv.data, sessionId, function(saveResult) {
          completed = true;
          completedData = saveResult;
          response = 'Registro completado con exito!\n\n';
          response += 'Estudiante: ' + conv.data.studentName + '\n';
          response += 'Grado: ' + conv.data.grade + '\n';
          response += 'Turno: ' + conv.data.shift + '\n';
          response += 'Seccion: ' + conv.data.section + '\n';
          if (conv.data.hasCertificate) {
            response += 'Certificado: Si (' + (conv.data.certificateFile ? conv.data.certificateFile.originalname : 'adjunto') + ')\n';
          } else {
            response += 'Justificacion: ' + (conv.data.justification || '') + '\n';
          }
          response += '\n';
          if (saveResult.telegramSent) response += 'Notificacion enviada por Telegram\n';
          if (saveResult.sheetRow) response += 'Registro guardado en Google Sheets\n';
          response += '\nGracias por usar nuestro sistema!\nDesea registrar otra inasistencia?';
          options = ['Si, registrar otra', 'No, gracias'];
          delete conversations[sessionId];
          res.json({ success: true, response: response, sessionId: sessionId, options: options, showUpload: showUpload, showSummary: showSummary, completed: completed, completedData: completedData });
        });
        return;
      }
      response = 'Desea registrar otra inasistencia?';
      options = ['Si, registrar otra', 'No, gracias'];
      delete conversations[sessionId];
      break;

    default:
      conversations[sessionId] = { step: 'welcome', data: {} };
      response = 'Bienvenido de nuevo! Cual es el nombre completo del estudiante?';
  }

  res.json({ success: true, response: response, sessionId: sessionId, options: options, showUpload: showUpload, showSummary: showSummary, completed: completed, completedData: completedData });
});

function buildSummary(data) {
  var s = 'RESUMEN DEL REGISTRO\n';
  s += 'Estudiante: ' + data.studentName + '\n';
  s += 'Grado: ' + data.grade + '\n';
  s += 'Turno: ' + data.shift + '\n';
  s += 'Seccion: ' + data.section + '\n';
  if (data.hasCertificate) {
    s += 'Certificado: Si - ' + (data.certificateFile ? data.certificateFile.originalname : 'adjunto') + '\n';
  } else {
    s += 'Certificado: No\nJustificacion: ' + data.justification + '\n';
  }
  s += '\nTodo esta correcto? Presione Enviar para confirmar.';
  return s;
}

function saveSubmission(data, sessionId, callback) {
  var result = { id: 'SUB-' + Date.now(), savedAt: new Date().toISOString(), telegramSent: false, sheetRow: null, driveFileId: null };

  if (telegramBot && CONFIG.TELEGRAM_CHAT_ID) {
    var msg = 'NUEVA INASISTENCIA REGISTRADA\n\n';
    msg += 'Estudiante: ' + data.studentName + '\n';
    msg += 'Grado: ' + data.grade + '\n';
    msg += 'Turno: ' + data.shift + '\n';
    msg += 'Seccion: ' + data.section + '\n';
    msg += 'Certificado: ' + (data.hasCertificate ? 'Si' : 'No') + '\n';
    if (data.hasCertificate && data.certificateFile) {
      msg += 'Archivo: ' + data.certificateFile.originalname + '\n';
    } else {
      msg += 'Justificacion: ' + (data.justification || 'N/A') + '\n';
    }
    msg += 'Fecha: ' + new Date().toLocaleString('es-PY') + '\n';
    msg += 'ID: ' + result.id;

    telegramBot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, msg).then(function() {
      result.telegramSent = true;
      if (data.certificateFile && data.certificateFile.path && fs.existsSync(data.certificateFile.path)) {
        var isPdf = data.certificateFile.mimetype === 'application/pdf';
        if (isPdf) {
          telegramBot.sendDocument(CONFIG.TELEGRAM_CHAT_ID, data.certificateFile.path, { caption: 'Certificado de ' + data.studentName });
        } else {
          telegramBot.sendPhoto(CONFIG.TELEGRAM_CHAT_ID, data.certificateFile.path, { caption: 'Certificado de ' + data.studentName });
        }
      }
      saveToSheet(data, result, callback);
    }).catch(function() {
      saveToSheet(data, result, callback);
    });
  } else {
    saveToSheet(data, result, callback);
  }
}

function saveToSheet(data, result, callback) {
  if (sheets && CONFIG.SPREADSHEET_ID) {
    var row = [
      result.id,
      new Date().toLocaleString('es-PY'),
      data.studentName,
      data.grade,
      data.shift,
      data.section,
      data.hasCertificate ? (data.certificateFile ? data.certificateFile.originalname : 'Adjunto') : 'Sin certificado',
      data.hasCertificate ? 'Con certificado' : 'Justificacion escrita',
      data.hasCertificate ? '' : (data.justification || ''),
      '',
    ];
    sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: "'" + CONFIG.SHEET_NAME + "'!A:J",
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    }).then(function() {
      result.sheetRow = 'OK';
      if (data.certificateFile && data.certificateFile.path && fs.existsSync(data.certificateFile.path)) {
        result.driveFileId = 'local';
      }
      submissions.push({ id: result.id, data: data });
      callback(result);
    }).catch(function() {
      if (data.certificateFile && data.certificateFile.path && fs.existsSync(data.certificateFile.path)) {
        result.driveFileId = 'local';
      }
      submissions.push({ id: result.id, data: data });
      callback(result);
    });
  } else {
    if (data.certificateFile && data.certificateFile.path && fs.existsSync(data.certificateFile.path)) {
      result.driveFileId = 'local';
    }
    submissions.push({ id: result.id, data: data });
    callback(result);
  }
}

app.listen(PORT, function() {
  console.log('Esc. Basica N1281 - Katuete');
  console.log('Servidor: http://localhost:' + PORT);
  console.log('Sheets: ' + (CONFIG.SPREADSHEET_ID ? 'OK' : 'NO'));
  console.log('Telegram: ' + (CONFIG.TELEGRAM_BOT_TOKEN ? 'OK' : 'NO'));
});
