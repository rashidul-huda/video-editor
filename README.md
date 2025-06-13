
# 🎵 Video Clip Editor & Trimmer

This project is a full-stack web-based video editor designed to sync short video clips to audio beat intervals. It provides two interfaces:
- **Main Editor** (`index.html`): Upload an audio file and multiple video clips. The app detects beats and stitches videos in sync.
- **Multi-Video Trimmer** (`videotrimmer.html`): Upload videos and trim them into fixed-length clips for reuse in the editor.

## ✨ Features

- Audio waveform visualization and beat detection
- Drag-and-drop video upload with real-time validation
- Auto-sync videos to beat intervals
- Optional randomization of video clip order
- Server-side processing using FFmpeg
- WebSocket-based real-time status updates
- Beautiful animated UI with progress feedback
- Download final output as MP4 or ZIP archive

## 🚀 Demo Pages

- Main Editor: `index.html`
- Video Trimmer: `videotrimmer.html`

> ⚙️ This project uses **Node.js**, **Express**, **FFmpeg**, **Vite**, and **WebSockets**.

---

## 🛠️ Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Run the App

```bash
npm run dev
```

This will:
- Start the Node.js server at `http://localhost:3001`
- Start the Vite frontend at `http://localhost:5173`

---

## 📂 Project Structure

```
├── index.html               # Main beat-synced video editor UI
├── videotrimmer.html        # Tool to trim uploaded videos
├── server.js                # Express + FFmpeg + WebSocket backend
├── vite.config.js           # Vite config with proxy setup
├── uploads/                 # Uploaded files (auto-created)
├── output/                  # Final ZIP/video outputs
├── temp/                    # Temporary processing files
└── package.json
```

---

## ⚙️ Server Features (`server.js`)

- **Audio Upload & Beat Sync**: Upload `.mp3` and extract beat intervals
- **Video Upload & Validation**: Validates format (1280x720, H264, AAC, 24fps)
- **Clip Trimming**: Auto-generates fixed-length segments
- **Final Output Processing**: Matches clip durations to beats and merges
- **ZIP Generation**: Bulk download option

---

## 🧪 Tech Stack

- **Frontend**: Vanilla JS, HTML5 Canvas, WebSocket
- **Backend**: Node.js, Express, FFmpeg, Multer, WebSocket (`ws`)
- **Build Tool**: Vite
- **Video Processing**: `fluent-ffmpeg`

---

## 📦 Output Format

- Final video: `.mp4` (1280x720, H.264, AAC, 24fps)
- Clips: Individually downloadable or bundled in `.zip`

---

## 📍 Notes

- Server must be running locally (`http://localhost:3001`)
- Ensure `ffmpeg` is installed and accessible in your system PATH
- Tested with modern Chromium-based browsers

---

## 🔗 License

This project is licensed under the **ISC License**

---

## 👤 Author

[**rashidul-huda**](https://github.com/rashidul-huda)
