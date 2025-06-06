const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { ytdlp } = require("ytdlp-nodejs");
const archiver = require("archiver");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin:
      process.env.NODE_ENV === "production"
        ? ["https://your-render-domain.onrender.com"]
        : "*",
  },
});

ytdlp.setBinaryPath("/usr/local/bin/yt-dlp");

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(path.join(__dirname, "downloads")));

const downloadsDir = path.join(__dirname, "downloads");
fs.mkdirSync(downloadsDir, { recursive: true });

const getPlatform = (url) => {
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  if (url.includes("vimeo.com")) return "vimeo";
  if (url.includes("twitter.com") || url.includes("x.com")) return "twitter";
  if (url.includes("facebook.com")) return "facebook";
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("tiktok.com")) return "tiktok";
  return "default";
};

app.post("/info", async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ success: false, error: "URL is required." });
  }
  try {
    const info = await ytdlp.getInfo(url);
    res.json({
      success: true,
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration_string,
      isPlaylist: info._type === "playlist",
      entryCount: info.entries ? info.entries.length : 1,
      platform: getPlatform(url),
      entries:
        info._type === "playlist"
          ? info.entries.map((e) => ({ title: e.title, url: e.webpage_url }))
          : [],
    });
  } catch (error) {
    console.error("Error fetching video info:", error.message);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch video information." });
  }
});

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  socket.on(
    "start-download",
    async ({ url, isPlaylist, entries, playlistTitle }) => {
      if (!url) return socket.emit("error", "URL is required.");

      if (isPlaylist) {
        const playlistId = uuidv4();
        const playlistDir = path.join(downloadsDir, playlistId);
        fs.mkdirSync(playlistDir, { recursive: true });
        const zipFileName = `${
          playlistTitle.replace(/[^a-zA-Z0-9]/g, "_") || "playlist"
        }.zip`;
        const zipFilePath = path.join(downloadsDir, zipFileName);

        socket.emit("playlist-progress", {
          status: "starting",
          message: `Preparing to download ${entries.length} videos...`,
        });

        for (let i = 0; i < entries.length; i++) {
          const video = entries[i];
          const videoIndex = i + 1;
          socket.emit("playlist-progress", {
            status: "video-start",
            message: `Downloading video ${videoIndex} of ${entries.length}: "${video.title}"`,
            overallPercent: Math.round((i / entries.length) * 100),
            videoIndex: videoIndex,
            totalVideos: entries.length,
          });

          try {
            await ytdlp.download(video.url, {
              format:
                "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
              output: path.join(playlistDir, `%(title)s.%(ext)s`),
              onProgress: (progress) => {
                socket.emit("video-progress", {
                  percent: progress.percent,
                  videoIndex: videoIndex,
                });
              },
            });
          } catch (err) {
            socket.emit("playlist-progress", {
              status: "video-error",
              message: `Skipping "${video.title}" due to an error.`,
            });
            console.error(`Error downloading ${video.title}:`, err.message);
          }
        }

        socket.emit("playlist-progress", {
          status: "zipping",
          message: "All videos downloaded. Creating ZIP file...",
          overallPercent: 100,
        });
        const output = fs.createWriteStream(zipFilePath);
        const archive = archiver("zip", { zlib: { level: 9 } });

        output.on("close", () => {
          socket.emit("zip-ready", {
            filePath: `/downloads/${zipFileName}`,
            fileName: zipFileName,
          });
          fs.rm(playlistDir, { recursive: true, force: true }, () => {});
        });
        archive.on("error", (err) => {
          throw err;
        });
        archive.pipe(output);
        archive.directory(playlistDir, false);
        await archive.finalize();
      } else {
        try {
          await ytdlp.download(url, {
            format: "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            output: path.join(downloadsDir, "%(title)s.%(ext)s"),
            onProgress: (progress) =>
              socket.emit("video-progress", { percent: progress.percent }),
          });
          const files = fs
            .readdirSync(downloadsDir)
            .map((file) => ({
              file,
              mtime: fs.statSync(path.join(downloadsDir, file)).mtime,
            }))
            .sort((a, b) => b.mtime - a.mtime);
          if (files.length > 0) {
            const filePath = `/downloads/${files[0].file}`;
            socket.emit("download-complete", {
              filePath: filePath,
              fileName: files[0].file,
            });
          } else {
            throw new Error("Could not find downloaded file.");
          }
        } catch (error) {
          console.error(`Download error for ${url}:`, error.message);
          socket.emit("error", "Failed to download the video.");
        }
      }
    }
  );

  socket.on("disconnect", () => console.log("User disconnected:", socket.id));
});

server.listen(PORT, () => {
  console.log(`Server is sparkling on http://localhost:${PORT}`);
});
