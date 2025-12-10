import express from 'express';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import archiver from 'archiver';

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

// Validate and standardize videos endpoint
app.post('/validate-videos', async (req, res) => {
  try {
    const { videoFiles, resolution } = req.body;
    const clientId = req.headers['x-client-id'];
    
    if (!videoFiles || !Array.isArray(videoFiles)) {
      return res.status(400).json({ error: 'Invalid video files data' });
    }

    // Determine target resolution
    const is720p = resolution === '720p';
    const targetWidth = is720p ? 1280 : 1920;
    const targetHeight = is720p ? 720 : 1088;
    const resolutionString = `${targetWidth}x${targetHeight}`;

    const startTime = Date.now();
    broadcastToClient(clientId, { type: 'status', message: `🔍 Validating and standardizing video files to ${resolutionString}...` });
    
    const validationResults = [];
    const targetFormat = {
      width: targetWidth,
      height: targetHeight,
      frameRate: 24,
      videoCodec: 'h264',
      audioCodec: 'aac'
    };

    // Estimate remaining time: 5s per file
    const estimatedValidationTime = videoFiles.length * 5000; // in milliseconds
    broadcastToClient(clientId, {
      type: 'progress-update',
      phase: 'validation',
      percent: 0,
      elapsedTime: 0,
      estimatedTimeLeft: estimatedValidationTime / 1000, // in seconds
      overallPercent: 0,
      overallElapsedTime: 0
    });

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
                '-c:v', 'libx264',
                '-crf', '0',
                '-r', '24',
                '-s', resolutionString,
                '-ar', '48000',
                '-ac', '2',
                '-b:a', '140k'
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

      // Send progress update with actual elapsed time
      const progressPercent = ((i + 1) / videoFiles.length) * 100;
      const elapsedTime = (Date.now() - startTime) / 1000; // in seconds
      const estimatedTimeLeft = (estimatedValidationTime * (videoFiles.length - (i + 1)) / videoFiles.length) / 1000;
      broadcastToClient(clientId, {
        type: 'progress-update',
        phase: 'validation',
        percent: progressPercent,
        elapsedTime: elapsedTime,
        estimatedTimeLeft: Math.max(0, estimatedTimeLeft),
        overallPercent: (progressPercent / 2),
        overallElapsedTime: elapsedTime
      });
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

// Trim videos endpoint
app.post('/trim-videos', upload.array('videos'), async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'];
    const duration = parseFloat(req.body.duration);
    const resolution = req.body.resolution; // Extract resolution from request
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No video files uploaded' });
    }
    if (!duration || duration <= 0) {
      return res.status(400).json({ error: 'Invalid clip duration' });
    }

    // Determine target resolution based on input
    const is720p = resolution === '720p';
    const resolutionString = is720p ? '1280x720' : '1920x1088';

    const sessionId = uuidv4();
    const sessionTempDir = path.join(tempDir, sessionId);
    await fs.mkdir(sessionTempDir, { recursive: true });

    broadcastToClient(clientId, { type: 'status', message: `📤 Uploading and validating videos (${resolutionString})...` });

    // First pass: calculate total clips
    let totalClips = 0;
    const videoMetadata = [];
    
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const filePath = path.join(uploadsDir, file.filename);
      
      // Get video metadata
      const metadata = await new Promise((resolve, reject) => {
        ffmpeg(filePath)
          .ffprobe((err, metadata) => {
            if (err) reject(err);
            else resolve(metadata);
          });
      });

      const videoDuration = metadata.format.duration;
      const clipCount = Math.floor(videoDuration / duration);
      totalClips += clipCount;
      
      videoMetadata.push({
        file,
        filePath,
        videoDuration,
        clipCount
      });
    }

    // Send initial progress info
    broadcastToClient(clientId, {
      type: 'progress',
      totalClips: totalClips,
      processedClips: 0,
      currentVideo: '',
      currentVideoIndex: 0,
      totalVideos: req.files.length
    });

    const clips = [];
    let processedClips = 0;

    for (let i = 0; i < videoMetadata.length; i++) {
      const { file, filePath, videoDuration, clipCount } = videoMetadata[i];
      
      broadcastToClient(clientId, { 
        type: 'status', 
        message: `🔍 Processing video ${i + 1}/${req.files.length}: ${file.originalname}` 
      });
      
      broadcastToClient(clientId, {
        type: 'progress',
        currentVideo: file.originalname,
        currentVideoIndex: i + 1,
        totalVideos: req.files.length
      });

      for (let j = 0; j < clipCount; j++) {
        const startTime = j * duration;
        const outputPath = path.join(sessionTempDir, `clip_${i}_${j}.mp4`);
        
        broadcastToClient(clientId, { 
          type: 'status', 
          message: `✂️ Generating clip ${j + 1}/${clipCount} from ${file.originalname}` 
        });

        await new Promise((resolve, reject) => {
          ffmpeg(filePath)
            .setStartTime(startTime)
            .setDuration(duration)
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions([
              '-c:v', 'libx264',
              '-crf', '0',
              '-r', '24',
              '-s', resolutionString, // Use dynamic resolution
              '-ar', '48000',
              '-ac', '2',
              '-b:a', '140k'
            ])
            .output(outputPath)
            .on('end', () => {
              console.log(`Generated clip ${j + 1} for ${file.originalname}`);
              resolve();
            })
            .on('error', (err, stdout, stderr) => {
              console.error(`Error generating clip for ${file.originalname}:`, stderr);
              reject(err);
            })
            .run();
        });

        clips.push({
          filename: `clip_${i}_${j}.mp4`,
          originalName: file.originalname,
          downloadUrl: `/download-clip/${sessionId}/clip_${i}_${j}.mp4`
        });

        processedClips++;
        
        // Send progress update
        broadcastToClient(clientId, {
          type: 'progress',
          totalClips: totalClips,
          processedClips: processedClips,
          currentVideo: file.originalname,
          currentVideoIndex: i + 1,
          totalVideos: req.files.length
        });
      }
    }

    broadcastToClient(clientId, { type: 'status', message: '📦 Creating ZIP archive...' });

    // Create ZIP file
    const zipPath = path.join(outputDir, `clips_${sessionId}.zip`);
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    await new Promise((resolve, reject) => {
      archive.on('error', err => reject(err));
      output.on('close', () => resolve());
      
      archive.pipe(output);
      for (const clip of clips) {
        archive.file(path.join(sessionTempDir, clip.filename), { name: clip.filename });
      }
      archive.finalize();
    });

    broadcastToClient(clientId, { type: 'status', message: '🎉 Clips generated successfully!' });

    res.json({
      success: true,
      clips,
      zipUrl: `/download-zip/${sessionId}`,
      sessionId
    });

  } catch (error) {
    console.error('Trimming error:', error);
    broadcastToClient(req.headers['x-client-id'], { type: 'status', message: `❌ Error: ${error.message}` });
    res.status(500).json({ error: 'Failed to trim videos: ' + error.message });
  }
});

// Download clip endpoint
app.get('/download-clip/:sessionId/:filename', async (req, res) => {
  try {
    const { sessionId, filename } = req.params;
    const filePath = path.join(tempDir, sessionId, filename);
    
    await fs.access(filePath);
    
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    const stream = fsSync.createReadStream(filePath);
    stream.pipe(res);
    
  } catch (error) {
    console.error('Download clip error:', error);
    res.status(404).json({ error: 'Clip not found' });
  }
});

// Download ZIP endpoint
app.get('/download-zip/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const filePath = path.join(outputDir, `clips_${sessionId}.zip`);
    
    await fs.access(filePath);
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="clips_${sessionId}.zip"`);
    
    const stream = fsSync.createReadStream(filePath);
    stream.pipe(res);
    
  } catch (error) {
    console.error('Download ZIP error:', error);
    res.status(404).json({ error: 'ZIP file not found' });
  }
});

// Process videos endpoint
app.post('/process-videos', async (req, res) => {
  try {
    const { audioFile, videoFiles, beats, randomized, resolution } = req.body;
    const clientId = req.headers['x-client-id'];
    
    if (!audioFile || !videoFiles || !beats) {
      return res.status(400).json({ error: 'Missing required data' });
    }

    // Determine target resolution
    const is720p = resolution === '720p';
    const resolutionString = is720p ? '1280x720' : '1920x1088';

    const sessionId = uuidv4();
    const sessionTempDir = path.join(tempDir, sessionId);
    await fs.mkdir(sessionTempDir, { recursive: true });
    
    const overallStartTime = Date.now();
    broadcastToClient(clientId, { type: 'status', message: '🔁 Starting video processing...' });
    
    // Calculate durations for each beat interval
    const durations = [];
    for (let i = 0; i < beats.length - 1; i++) {
      durations.push(beats[i + 1] - beats[i]);
    }
    durations.push(2.0); // Default 2 seconds for last segment

    // Estimate remaining time: 10s per clip + 30s for concatenation/audio
    const totalClips = durations.length;
    const estimatedProcessingTime = (totalClips * 10000) + 30000; // in milliseconds
    broadcastToClient(clientId, {
      type: 'progress-update',
      phase: 'processing',
      percent: 0,
      elapsedTime: 0,
      estimatedTimeLeft: estimatedProcessingTime / 1000, // in seconds
      overallPercent: 50,
      overallElapsedTime: (Date.now() - overallStartTime) / 1000
    });

    // Match clips to durations
    const availableClips = videoFiles.filter(file => file.valid);
    const assignedClips = [];

    // Helper function to shuffle array
    const shuffleArray = (array) => {
      const shuffled = [...array];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
    };

    if (randomized) {
      const shuffledClips = shuffleArray(availableClips.map((clip, index) => ({ ...clip, index })));
      const usedClipIndices = new Set();

      for (const duration of durations) {
        let bestClip = null;
        let minDurationDiff = Infinity;

        for (const clip of shuffledClips) {
          if (usedClipIndices.has(clip.index)) continue;
          const clipDuration = clip.duration;
          if (clipDuration >= duration) {
            const durationDiff = clipDuration - duration;
            if (durationDiff < minDurationDiff) {
              minDurationDiff = durationDiff;
              bestClip = clip;
            }
          }
        }

        if (!bestClip) {
          for (const clip of shuffledClips) {
            if (!usedClipIndices.has(clip.index)) {
              bestClip = clip;
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
    } else {
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
    }

    // Process assigned clips
    const trimmedFiles = [];
    const startTime = Date.now();
    
    for (let i = 0; i < assignedClips.length; i++) {
      const videoFile = assignedClips[i];
      const duration = durations[i];
      const inputPath = videoFile.path;
      const outputPath = path.join(sessionTempDir, `trimmed_${i}.mp4`);
      
      broadcastToClient(clientId, { 
        type: 'status', 
        message: `✂️ Trimming clip ${i + 1}/${assignedClips.length}: ${videoFile.originalName}` 
      });

      if (videoFile.duration >= duration) {
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .setStartTime(0)
            .setDuration(duration)
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions([
              '-c:v', 'libx264',
              '-crf', '0',
              '-avoid_negative_ts', 'make_zero',
              '-fflags', '+genpts',
              '-r', '24',
              '-s', resolutionString,
              '-c:a', 'copy'
            ])
            .output(outputPath)
            .on('end', () => {
              console.log(`Trimming completed for ${videoFile.originalName}`);
              resolve();
            })
            .on('error', (err, stdout, stderr) => {
              console.error(`Trimming error for ${videoFile.originalName}:`, stderr);
              reject(err);
            })
            .run();
        });
      } else {
        const forwardPath = path.join(sessionTempDir, `forward_${i}.mp4`);
        const reversePath = path.join(sessionTempDir, `reverse_${i}.mp4`);
        const concatPath = path.join(sessionTempDir, `concat_${i}.mp4`);

        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions([
              '-c:v', 'libx264',
              '-crf', '0',
              '-avoid_negative_ts', 'make_zero',
              '-fflags', '+genpts',
              '-r', '24',
              '-s', resolutionString,
              '-c:a', 'copy'
            ])
            .output(forwardPath)
            .on('end', () => {
              console.log(`Forward clip created for ${videoFile.originalName}`);
              resolve();
            })
            .on('error', (err, stdout, stderr) => {
              console.error(`Forward clip error for ${videoFile.originalName}:`, stderr);
              reject(err);
            })
            .run();
        });

        await new Promise((resolve, reject) => {
          ffmpeg(forwardPath)
            .videoFilters('reverse')
            .audioFilters('areverse')
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions([
              '-c:v', 'libx264',
              '-crf', '0',
              '-avoid_negative_ts', 'make_zero',
              '-fflags', '+genpts',
              '-r', '24',
              '-s', resolutionString,
              '-c:a', 'copy'
            ])
            .output(reversePath)
            .on('end', () => {
              console.log(`Reverse clip created for ${videoFile.originalName}`);
              resolve();
            })
            .on('error', (err, stdout, stderr) => {
              console.error(`Reverse clip error for ${videoFile.originalName}:`, stderr);
              reject(err);
            })
            .run();
        });

        const concatListPath = path.join(sessionTempDir, `concat_list_${i}.txt`);
        const concatListContent = `file '${forwardPath}'\nfile '${reversePath}'`;
        await fs.writeFile(concatListPath, concatListContent);

        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(concatListPath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions([
              '-c:v', 'libx264',
              '-crf', '0',
              '-avoid_negative_ts', 'make_zero',
              '-fflags', '+genpts',
              '-r', '24',
              '-s', resolutionString,
              '-c:a', 'copy'
            ])
            .output(concatPath)
            .on('end', () => {
              console.log(`Concatenation completed for ${videoFile.originalName}`);
              resolve();
            })
            .on('error', (err, stdout, stderr) => {
              console.error(`Concatenation error for ${videoFile.originalName}:`, stderr);
              reject(err);
            })
            .run();
        });

        await new Promise((resolve, reject) => {
          ffmpeg(concatPath)
            .setStartTime(0)
            .setDuration(duration)
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions([
              '-c:v', 'libx264',
              '-crf', '0',
              '-avoid_negative_ts', 'make_zero',
              '-fflags', '+genpts',
              '-r', '24',
              '-s', resolutionString,
              '-c:a', 'copy'
            ])
            .output(outputPath)
            .on('end', () => {
              console.log(`Final trimming completed for ${videoFile.originalName}`);
              resolve();
            })
            .on('error', (err, stdout, stderr) => {
              console.error(`Final trimming error for ${videoFile.originalName}:`, stderr);
              reject(err);
            })
            .run();
        });

        await Promise.all([
          fs.unlink(forwardPath).catch(() => {}),
          fs.unlink(reversePath).catch(() => {}),
          fs.unlink(concatPath).catch(() => {}),
          fs.unlink(concatListPath).catch(() => {})
        ]);
      }
      
      trimmedFiles.push(outputPath);

      // Send progress update with actual elapsed time
      const trimmingPercent = ((i + 1) / totalClips) * 80; // Trimming ~80%
      const elapsedTime = (Date.now() - startTime) / 1000; // in seconds
      const estimatedTimeLeft = (estimatedProcessingTime * (totalClips - (i + 1)) / totalClips) / 1000;
      const overallElapsedTime = (Date.now() - overallStartTime) / 1000;
      broadcastToClient(clientId, {
        type: 'progress-update',
        phase: 'processing',
        percent: trimmingPercent,
        elapsedTime: elapsedTime,
        estimatedTimeLeft: Math.max(0, estimatedTimeLeft),
        overallPercent: 50 + (trimmingPercent / 2),
        overallElapsedTime: overallElapsedTime
      });
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

    // Send progress update for concatenation
    const elapsedTime = (Date.now() - startTime) / 1000;
    const overallElapsedTime = (Date.now() - overallStartTime) / 1000;
    broadcastToClient(clientId, {
      type: 'progress-update',
      phase: 'processing',
      percent: 90,
      elapsedTime: elapsedTime,
      estimatedTimeLeft: Math.max(0, (estimatedProcessingTime * 0.1) / 1000),
      overallPercent: 95,
      overallElapsedTime: overallElapsedTime
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
          '-b:a', '192k'
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

    // Send final progress update
    const finalElapsedTime = (Date.now() - startTime) / 1000;
    const finalOverallElapsedTime = (Date.now() - overallStartTime) / 1000;
    broadcastToClient(clientId, {
      type: 'progress-update',
      phase: 'processing',
      percent: 100,
      elapsedTime: finalElapsedTime,
      estimatedTimeLeft: 0,
      overallPercent: 100,
      overallElapsedTime: finalOverallElapsedTime
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
    broadcastToClient(req.headers['x-client-id'], { type: 'status', message: `❌ Error: ${error.message}` });
    res.status(500).json({ error: 'Failed to process videos: ' + error.message });
  }
});

// Download endpoint
app.get('/download/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const filePath = path.join(outputDir, `final_${sessionId}.mp4`);

    await fs.access(filePath);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="final-video-${sessionId}.mp4"`);

    const stream = fsSync.createReadStream(filePath);

    stream.on('error', (err) => {
      console.error('Stream error:', err);
      res.status(500).end("Error reading file");
    });

    stream.pipe(res);

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
    
    const uploadFiles = await fs.readdir(uploadsDir);
    for (const file of uploadFiles) {
      const filePath = path.join(uploadsDir, file);
      const stats = await fs.stat(filePath);
      if (now - stats.mtime.getTime() > maxAge) {
        await fs.unlink(filePath);
      }
    }
    
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
}, 60 * 60 * 1000);
