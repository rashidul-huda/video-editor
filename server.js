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

// Create uploads, temp, and output directories
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
      originalName: file.originalName,
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

// Validate and standardize videos endpoint
app.post('/validate-videos', async (req, res) => {
  try {
    const { videoFiles } = req.body;
    const clientId = req.headers['x-client-id'];
    
    if (!videoFiles || !Array.isArray(videoFiles)) {
      return res.status(400).json({ error: 'Invalid video files data' });
    }

    broadcastToClient(clientId, { type: 'status', message: '🔍 Validating and standardizing video files...' });
    
    const validationResults = [];
    const standardizedFiles = [];
    const targetFormat = {
      width: 1280,
      height: 720,
      frameRate: 24,
      videoCodec: 'h264',
      audioCodec: 'aac'
    };

    for (let i = 0; i < videoFiles.length; i++) {
      const file = videoFiles[i];
      const filePath = path.join(uploadsDir, file.filename);
      const standardizedPath = path.join(tempDir, `standardized_${uuidv4()}.mp4`);
      
      broadcastToClient(clientId, { 
        type: 'status', 
        message: `🔍 Checking file ${i + 1}/${videoFiles.length}: ${file.originalName}` 
      });
      
      try {
        // Check if file exists
        await fs.access(filePath);
        
        // Get metadata with ffprobe
        const metadata = await new Promise((resolve, reject) => {
          ffmpeg(filePath)
            .ffprobe((err, metadata) => {
              if (err) reject(err);
              else resolve(metadata);
            });
        });
        
        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
        if (!videoStream) {
          throw new Error('No video stream found');
        }

        const needsReencode = (
          videoStream.width !== targetFormat.width ||
          videoStream.height !== targetFormat.height ||
          eval(videoStream.r_frame_rate) !== targetFormat.frameRate ||
          videoStream.codec_name !== targetFormat.videoCodec ||
          (audioStream && audioStream.codec_name !== targetFormat.audioCodec)
        );

        let outputPath = filePath;
        let duration = metadata.format.duration;

        if (needsReencode) {
          broadcastToClient(clientId, { 
            type: 'status', 
            message: `📏 Standardizing file ${i + 1}/${videoFiles.length}: ${file.originalName}` 
          });
          
          await new Promise((resolve, reject) => {
            ffmpeg(filePath)
              .videoCodec('libx264')
              .audioCodec('aac')
              .outputOptions([
                '-crf', '15', // Visually lossless
                '-preset', 'veryslow', // Best compression
                '-b:v', '8M', // High bitrate for 720p
                '-maxrate', '10M',
                '-bufsize', '16M',
                '-r', '24', // 24fps
                '-s', '1280x720', // 720p
                '-ar', '44100', // Audio sample rate
                '-ac', '2', // Stereo
                '-b:a', '192k' // High-quality audio
              ])
              .output(standardizedPath)
              .on('end', () => {
                console.log(`Standardized ${file.originalName}`);
                resolve();
              })
              .on('error', (err, stdout, stderr) => {
                console.error(`Standardization error for ${file.originalName}:`, stderr);
                reject(err);
              })
              .run();
          });

          // Get duration of standardized file
          const newMetadata = await new Promise((resolve, reject) => {
            ffmpeg(standardizedPath)
              .ffprobe((err, metadata) => {
                if (err) reject(err);
                else resolve(metadata);
              });
          });
          duration = newMetadata.format.duration;
          outputPath = standardizedPath;
        }

        validationResults.push({
          filename: file.filename,
          originalName: file.originalName,
          valid: true,
          error: null,
          duration: duration,
          path: outputPath
        });
        
      } catch (error) {
        validationResults.push({
          filename: file.filename,
          originalName: file.originalName,
          valid: false,
          error: error.message,
          duration: 0,
          path: filePath
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
    durations.push(2.0); // Default 2 seconds for last segment

    // Match clips to durations
    const availableClips = videoFiles.filter(file => file.valid);
    const assignedClips = [];
    const usedClipIndices = new Set();

    for (const duration of durations) {
      let bestClip = null;
      let minDurationDiff = Infinity;

      for (let i = 0; i < availableClips.length; i++) {
        if (usedClipIndices.has(i)) continue;
        const clipDuration = availableClips[i].duration;
        if (clipDuration >= duration) {
          const durationDiff = clipDuration - duration;
          if (durationDiff < minDurationDiff) {
            minDurationDiff = durationDiff;
            bestClip = { ...availableClips[i], index: i };
          }
        }
      }

      if (!bestClip) {
        // Fallback: Use any unused clip and loop it if necessary
        for (let i = 0; i < availableClips.length; i++) {
          if (!usedClipIndices.has(i)) {
            bestClip = { ...availableClips[i], index: i };
            break;
          }
        }
      }

      if (!bestClip) {
        throw new Error('No suitable clip available for beat duration');
      }

      assignedClips.push(bestClip);
      usedClipIndices.add(bestClip.index);
    }

    // Process assigned clips
    const trimmedFiles = [];
    
    for (let i = 0; i < assignedClips.length; i++) {
      const videoFile = assignedClips[i];
      const duration = durations[i];
      const inputPath = videoFile.path;
      const outputPath = path.join(sessionTempDir, `trimmed_${i}.mp4`);
      
      broadcastToClient(clientId, { 
        type: 'status', 
        message: `✂️ Trimming clip ${i + 1}/${assignedClips.length}: ${videoFile.originalName}` 
      });
      
      await new Promise((resolve, reject) => {
        const cmd = ffmpeg(inputPath)
          .setStartTime(0)
          .setDuration(duration)
          .videoCodec('libx264')
          .audioCodec('aac')
          .outputOptions([
            '-crf', '15', // Visually lossless
            '-preset', 'veryslow', // Best compression
            '-b:v', '8M', // High bitrate for 720p
            '-maxrate', '10M',
            '-bufsize', '16M',
            '-avoid_negative_ts', 'make_zero',
            '-fflags', '+genpts',
            '-r', '24', // 24fps
            '-s', '1280x720', // 720p
            '-b:a', '192k' // High-quality audio
          ])
          .output(outputPath)
          .on('end', () => {
            console.log(`Trimming completed for ${videoFile.originalName}`);
            resolve();
          })
          .on('error', (err, stdout, stderr) => {
            console.error(`Trimming error for ${videoFile.originalName}:`, stderr);
            reject(err);
          });
        
        if (videoFile.duration < duration) {
          cmd.inputOptions(['-loop', '1']);
        }
        
        cmd.run();
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
        .outputOptions(['-fflags', '+genpts'])
        .output(mergedPath)
        .on('end', () => {
          console.log('Concatenation completed');
          resolve();
        })
        .on('error', (err, stdout, stderr) => {
          console.error('Concatenation error:', stderr);
          reject(err);
        })
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
          '-shortest',
          '-b:a', '192k' // High-quality audio
        ])
        .output(finalPath)
        .on('end', () => {
          console.log('Audio addition completed');
          resolve();
        })
        .on('error', (err, stdout, stderr) => {
          console.error('Audio addition error:', stderr);
          reject(err);
        })
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