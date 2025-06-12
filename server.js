import express from 'express';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

// Enable CORS for Vite dev server
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  credentials: true
}));

app.use(express.json());

// Create uploads and temp directories
const uploadsDir = path.join(__dirname, 'uploads');
const tempDir = path.join(__dirname, 'temp');
const outputDir = path.join(__dirname, 'output');

await fs.mkdir(uploadsDir, { recursive: true });
await fs.mkdir(tempDir, { recursive: true });
await fs.mkdir(outputDir, { recursive: true });

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB limit per file
  }
});

// WebSocket server for real-time updates
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server });
const clients = new Map();

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  clients.set(clientId, ws);
  console.log(`Client connected: ${clientId}`);
  
  ws.on('close', () => {
    clients.delete(clientId);
    console.log(`Client disconnected: ${clientId}`);
  });
  
  ws.send(JSON.stringify({ type: 'connected', clientId }));
});

function broadcastToClient(clientId, message) {
  const client = clients.get(clientId);
  if (client && client.readyState === 1) {
    client.send(JSON.stringify(message));
  }
}

// Upload audio endpoint
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }
    
    res.json({ 
      success: true, 
      filename: req.file.filename,
      path: req.file.path 
    });
  } catch (error) {
    console.error('Audio upload error:', error);
    res.status(500).json({ error: 'Failed to upload audio' });
  }
});

// Upload videos endpoint
app.post('/upload-videos', upload.array('videos'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No video files uploaded' });
    }
    
    const files = req.files.map(file => ({
      filename: file.filename,
      originalName: file.originalname,
      path: file.path,
      size: file.size
    }));
    
    res.json({ 
      success: true, 
      files: files,
      count: files.length
    });
  } catch (error) {
    console.error('Video upload error:', error);
    res.status(500).json({ error: 'Failed to upload videos' });
  }
});

// Validate videos endpoint
app.post('/validate-videos', async (req, res) => {
  try {
    const { videoFiles } = req.body;
    const clientId = req.headers['x-client-id'];
    
    if (!videoFiles || !Array.isArray(videoFiles)) {
      return res.status(400).json({ error: 'Invalid video files data' });
    }

    broadcastToClient(clientId, { type: 'status', message: '🔍 Validating video files...' });
    
    const validationResults = [];
    
    for (let i = 0; i < videoFiles.length; i++) {
      const file = videoFiles[i];
      const filePath = path.join(uploadsDir, file.filename);
      
      broadcastToClient(clientId, { 
        type: 'status', 
        message: `🔍 Checking file ${i + 1}/${videoFiles.length}: ${file.originalName}` 
      });
      
      try {
        // Check if file exists
        await fs.access(filePath);
        
        // Validate with ffmpeg
        await new Promise((resolve, reject) => {
          ffmpeg(filePath)
            .ffprobe((err, metadata) => {
              if (err) {
                reject(err);
              } else {
                resolve(metadata);
              }
            });
        });
        
        validationResults.push({
          filename: file.filename,
          originalName: file.originalName,
          valid: true,
          error: null
        });
        
      } catch (error) {
        validationResults.push({
          filename: file.filename,
          originalName: file.originalName,
          valid: false,
          error: error.message
        });
      }
    }
    
    const validCount = validationResults.filter(r => r.valid).length;
    broadcastToClient(clientId, { 
      type: 'status', 
      message: `✅ Validation complete: ${validCount}/${videoFiles.length} files are valid` 
    });
    
    res.json({ 
      success: true, 
      results: validationResults,
      validCount: validCount,
      totalCount: videoFiles.length
    });
    
  } catch (error) {
    console.error('Validation error:', error);
    res.status(500).json({ error: 'Failed to validate videos' });
  }
});

// Process videos endpoint
app.post('/process-videos', async (req, res) => {
  try {
    const { audioFile, videoFiles, beats } = req.body;
    const clientId = req.headers['x-client-id'];
    
    if (!audioFile || !videoFiles || !beats) {
      return res.status(400).json({ error: 'Missing required data' });
    }

    const sessionId = uuidv4();
    const sessionTempDir = path.join(tempDir, sessionId);
    await fs.mkdir(sessionTempDir, { recursive: true });
    
    broadcastToClient(clientId, { type: 'status', message: '🔁 Starting video processing...' });
    
    // Calculate durations for each beat interval
    const durations = [];
    for (let i = 0; i < beats.length - 1; i++) {
      durations.push(beats[i + 1] - beats[i]);
    }
    // Add duration for the last interval (assuming audio ends after last beat)
    durations.push(2.0); // Default 2 seconds for last segment, you might want to pass actual audio duration
    
    const trimmedFiles = [];
    
    // Process each video file
    for (let i = 0; i < videoFiles.length; i++) {
      const videoFile = videoFiles[i];
      const duration = durations[i];
      const inputPath = path.join(uploadsDir, videoFile.filename);
      const outputPath = path.join(sessionTempDir, `trimmed_${i}.mp4`);
      
      broadcastToClient(clientId, { 
        type: 'status', 
        message: `✂️ Trimming clip ${i + 1}/${videoFiles.length}: ${videoFile.originalName}` 
      });
      
      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .setStartTime(0)
          .setDuration(duration)
          .videoCodec('libx264')
          .audioCodec('aac')
          .outputOptions([
            '-avoid_negative_ts', 'make_zero',
            '-fflags', '+genpts'
          ])
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      
      trimmedFiles.push(outputPath);
    }
    
    // Create file list for concatenation
    const fileListPath = path.join(sessionTempDir, 'filelist.txt');
    const fileListContent = trimmedFiles.map(file => `file '${file}'`).join('\n');
    await fs.writeFile(fileListPath, fileListContent);
    
    broadcastToClient(clientId, { type: 'status', message: '🧱 Merging video clips...' });
    
    const mergedPath = path.join(sessionTempDir, 'merged.mp4');
    
    // Concatenate videos
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(fileListPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .videoCodec('copy')
        .audioCodec('copy')
        .output(mergedPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    
    broadcastToClient(clientId, { type: 'status', message: '🎵 Adding original audio track...' });
    
    const audioPath = path.join(uploadsDir, audioFile.filename);
    const finalPath = path.join(outputDir, `final_${sessionId}.mp4`);
    
    // Add original audio
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(mergedPath)
        .input(audioPath)
        .videoCodec('copy')
        .audioCodec('aac')
        .outputOptions([
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-shortest'
        ])
        .output(finalPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    
    broadcastToClient(clientId, { type: 'status', message: '🎉 Video processing complete!' });
    
    // Clean up temp files
    await fs.rm(sessionTempDir, { recursive: true, force: true });
    
    res.json({ 
      success: true, 
      outputFile: `final_${sessionId}.mp4`,
      downloadUrl: `/download/${sessionId}`
    });
    
  } catch (error) {
    console.error('Processing error:', error);
    broadcastToClient(req.headers['x-client-id'], { 
      type: 'status', 
      message: `❌ Error: ${error.message}` 
    });
    res.status(500).json({ error: 'Failed to process videos: ' + error.message });
  }
});

// Download endpoint
app.get('/download/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const filePath = path.join(outputDir, `final_${sessionId}.mp4`);
    
    // Check if file exists
    await fs.access(filePath);
    
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="final-video-${sessionId}.mp4"`);
    
    const fileStream = await fs.readFile(filePath);
    res.send(fileStream);
    
  } catch (error) {
    console.error('Download error:', error);
    res.status(404).json({ error: 'File not found' });
  }
});

// Cleanup old files periodically (run every hour)
setInterval(async () => {
  try {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    // Clean uploads
    const uploadFiles = await fs.readdir(uploadsDir);
    for (const file of uploadFiles) {
      const filePath = path.join(uploadsDir, file);
      const stats = await fs.stat(filePath);
      if (now - stats.mtime.getTime() > maxAge) {
        await fs.unlink(filePath);
      }
    }
    
    // Clean outputs
    const outputFiles = await fs.readdir(outputDir);
    for (const file of outputFiles) {
      const filePath = path.join(outputDir, file);
      const stats = await fs.stat(filePath);
      if (now - stats.mtime.getTime() > maxAge) {
        await fs.unlink(filePath);
      }
    }
    
    console.log('Cleanup completed');
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}, 60 * 60 * 1000); // Run every hour