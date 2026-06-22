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
  'Pre-Jardín', 'Jardín', 'Preparatoria',
  '1er Grado', '2do Grado', '3er Grado',
  '4to Grado', '5to Grado', '6to Grado',
  '7mo Grado', '8vo Grado', '9no Grado'
];

const SHIFTS = ['Mañana', 'Tarde'];
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
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, 'cert-' + unique + ext);
  },
});

const fileFilter = (_req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
  cb(null, allowed.includes(file.mimetype));
};

const upload = multer({ storage, fileFilter, limits: { fileSize: CONFIG.MAX_FILE_SIZE } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/chat', upload.single('certificate'), async (req, res) => {
  try {
    const sessionId = req.body.sessionId || 'default';
    const text = (req.body.message || '').trim();
    const file = req.file || null;

    if (!conversations[sessionId]) {
      conversations[sessionId] = { step: 'welcome', data: {}, createdAt: new Date().toISOString() };
    }

    const conv = conversations[sessionId];
    let response = '';
    let options = null;
    let showUpload = false;
    let showSummary = false;
    let completed = false;
    let completedData = null;

    if (file && conv.step !== 'upload_certificate') {
      conv.data.certificateFile = {
        filename: file.filename, originalname: file.originalname,
        mimetype: file.mimetype, size: file.size, path: file.path,
      };
      if (conv.step === 'welcome' || conv.step === 'name') {
        response = 'Recibi su archivo "' + file.originalname + '"! Lo guardare para el registro. Continuemos. Cual es el nombre completo del estudiante?';
        conv.step = 'name';
        return res.json({ success: true, response, sessionId });
      }
    }

    switch (conv.step) {
      case 'welcome':
        conv.step = 'name';
        response = 'Hola! Soy el asistente virtual de la Escuela Basica N 1281 Sagrado Corazon de Jesus - Katuete. Estoy aqui para ayudarle a registrar la inasistencia de su hijo/a. Solo necesito algunos datos y, si tiene un certificado medico, puede adjuntarlo directamente aqui. Cual es el nombre completo del estudiante?';
        break;

      case 'name': {
        const parts = text.split(/\s+/).filter(Boolean);
        if (!text || parts.length < 2) {
          response = 'Necesito el nombre y apellido del estudiante. Ejemplo: Maria Lopez Gonzalez';
          break;
        }
        conv.data.studentName = text;
        conv.step = 'grade';
        response = 'Perfecto, ' + text + '! Ahora seleccione el grado del estudiante:';
        options = GRADES;
        break;
      }

      case 'grade': {
        const idx = parseInt(text) - 1;
        const byIndex = !isNaN(idx) && idx >= 0 && idx < GRADES.length;
        const byName = GRADES.find(g => g.toLowerCase() === text.toLowerCase());
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
      }

      case 'shift': {
        const valid = SHIFTS.find(s => s.toLowerCase() === text.toLowerCase());
        if (!valid) {
          response = 'Seleccione un turno valido.';
          options = SHIFTS;
          break;
        }
        conv.data.shift = valid;
        conv.step = 'section';
        response = 'Turno: ' + valid + '. Seleccione la seccion:';
        options = SECTIONS;
        break;
      }

      case 'section': {
        const valid = SECTIONS.find(s => s.toLowerCase() === text.toLowerCase());
        if (!valid) {
          response = 'Seleccione una seccion valida (A o B).';
          options = SECTIONS;
          break;
        }
        conv.data.section = valid;
        conv.step = 'has_certificate';
        response = 'Seccion: ' + valid + '. Cuenta con certificado medico para justificar la inasistencia?';
        options = ['Si, tengo certificado', 'No, solo justificacion'];
        break;
      }

      case 'has_certificate': {
        const lower = text.toLowerCase();
        const hasCert = lower.includes('si') || lower.includes('certificado');
        const noCert = lower.includes('no') || lower.includes('justificacion');
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
      }

      case 'upload_certificate': {
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
      }

      case 'justification': {
        if (!text || text.length < 10) {
          response = 'La justificacion debe tener al menos 10 caracteres. Por favor detalle el motivo.';
          break;
        }
        conv.data.justification = text;
        conv.step = 'summary';
        showSummary = true;
        response = buildSummary(conv.data);
        break;
      }

      case 'summary': {
        if (conv.data.studentName) {
          const saveResult = await saveSubmission(conv.data, sessionId);
          completed = true;
          completedData = saveResult;
          response = 'Registro completado con exito!\n\n';
          response += 'Estudiante: ' + conv.data.studentName + '\n';
          response += 'Grado: ' + conv.data.grade + '\n';
          response += 'Turno: ' + conv.data.shift + '\n';
          response += 'Seccion: ' + conv.data.section + '\n';
          if (conv.data.hasCertificate) {
            response += 'Certificado: Si (' + (conv.data.certificateFile?.originalname || 'adjunto') + ')\n';
          } else {
            response += 'Justificacion: ' + (conv.data.justification || '') + '\n';
          }
          response += '\n';
          if (saveResult.telegramSent) response += 'Notificacion enviada por Telegram\n';
          if (saveResult.sheetRow) response += 'Registro guardado en Google Sheets\n';
          response += '\nGracias por usar nuestro sistema!\nDesea registrar otra inasistencia?';
          options = ['Si, registrar otra', 'No, gracias'];
          delete conversations[sessionId];
          break;
        }
        response = 'Desea registrar otra inasistencia?';
        options = ['Si, registrar otra', 'No, gracias'];
        delete conversations[sessionId];
        break;
      }

      default:
        conversations[sessionId] = { step: 'welcome', data: {}, createdAt: new Date().toISOString() };
        response = 'Bienvenido de nuevo! Cual es el nombre completo del estudiante?';
    }

    res.json({ success: true, response, sessionId, options, showUpload, showSummary, completed, completedData });
  } catch (err) {
    console.error('Error en /api/chat:', err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

function buildSummary(data) {
  let s = 'RESUMEN DEL REGISTRO\n';
  s += 'Estudiante: ' + data.studentName + '\n';
  s += 'Grado: ' + data.grade + '\n';
  s += 'Turno: ' + data.shift + '\n';
  s += 'Seccion: ' + data.section + '\n';
  if (data.hasCertificate) {
    s += 'Certificado: Si - ' + (data.certificateFile?.originalname || 'adjunto') + '\n';
  } else {
    s += 'Certificado: No\nJustificacion: ' + data.justification + '\n';
  }
  s += '\nTodo esta correcto? Presione Enviar para confirmar.';
  return s;
}

async function saveSubmission(data, sessionId) {
  const result = { id: 'SUB-' + Date.now(), savedAt: new Date().toISOString(), telegramSent: false, sheetRow: null, driveFileId: null };

  if (telegramBot && CONFIG.TELEGRAM_CHAT_ID) {
    try {
      let msg = 'NUEVA INASISTENCIA REGISTRADA\n\n';
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

      await telegramBot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, msg);

      if (data.certificateFile?.path && fs.existsSync(data.certificateFile.path)) {
        const isPdf = data.certificateFile.mimetype === 'application/pdf';
        if (isPdf) {
          await telegramBot.sendDocument(CONFIG.TELEGRAM_CHAT_ID, data.certificateFile.path, { caption: 'Certificado de ' + data.studentName });
        } else {
          await telegramBot.sendPhoto(CONFIG.TELEGRAM_CHAT_ID, data.certificateFile.path, { caption: 'Certificado de ' + data.studentName });
        }
      }
      result.telegramSent = true;
      console.log('Telegram enviado');
    } catch (e) {
      console.error('Error Telegram:', e.message);
    }
  }

  if (sheets && CONFIG.SPREADSHEET_ID) {
    try {
      const row = [
        result.id,
        new Date().toLocaleString('es-PY'),
        data.studentName,
        data.grade,
        data.shift,
        data.section,
        data.hasCertificate ? (data.certificateFile?.originalname || 'Adjunto') : 'Sin certificado',
        data.hasCertificate ? 'Con certificado' : 'Justificacion escrita',
        data.hasCertificate ? '' : (data.justification || ''),
        '',
      ];
      await sheets.spreadsheets.values.append({
        spreadsheetId: CONFIG.SPREADSHEET_ID,
        range: "'" + CONFIG.SHEET_NAME + "'!A:J",
        valueInputOption: 'USER_ENTERED',
        resource: { values: [row] },
      });
      result.sheetRow = 'OK';
      console.log('Google Sheets actualizado');
    } catch (e) {
      console.error('Error Google Sheets:', e.message);
    }
  }

  if (data.certificateFile?.path && fs.existsSync(data.certificateFile.path)) {
    result.driveFileId = 'local';
    result.driveLink = '/uploads/' + data.certificateFile.filename;
    console.log('Archivo guardado localmente');
  }

  submissions.push({ ...result, data });
  return result;
}

app.listen(PORT, () => {
  console.log('Esc. Basica N1281 - Katuete');
  console.log('Servidor: http://localhost:' + PORT);
  console.log('Sheets: ' + (CONFIG.SPREADSHEET_ID ? 'OK' : 'NO'));
  console.log('Telegram: ' + (CONFIG.TELEGRAM_BOT_TOKEN ? 'OK' : 'NO'));
});
