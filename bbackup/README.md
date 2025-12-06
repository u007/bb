# Cross-Platform Backup Application

A modern, efficient backup application built with Wails v2, featuring a Go backend and React/TypeScript frontend. Uses Content-Addressable Storage (CAS) for space-efficient, Time Machine-like versioning across multiple filesystems.

## Features

### 🚀 Core Capabilities
- **Content-Addressable Storage**: Deduplication through SHA-256 hashing
- **Incremental Backups**: Only stores changed files
- **Cross-Platform**: Works on macOS, Windows, and Linux
- **Universal Filesystem Support**: Compatible with exFAT, APFS, ext4, NTFS, and more
- **Real-time Progress**: Live backup status and file processing updates
- **Smart Ignore Patterns**: Exclude files/folders with glob patterns or absolute paths

### 💾 Storage Architecture
- **Object Store**: Hierarchical storage (`objects/ab/cd/abcdef...`) prevents directory bloat
- **Snapshots**: Lightweight JSON manifests track file states at each backup point
- **Efficient**: Only unique content is stored; unchanged files reference existing hashes

### 🎨 User Interface
- Intuitive source directory management
- Customizable ignore patterns with smart defaults
- Persistent destination path configuration
- Comprehensive logging and progress tracking

## Quick Start

### Prerequisites
- Go 1.21 or higher
- Node.js 18+ and npm
- Wails CLI v2.9.2

### Installation

```bash
# Install Wails CLI (if not already installed)
go install github.com/wailsapp/wails/v2/cmd/wails@latest

# Clone the repository
cd bbackup

# Install dependencies
go mod download
```

### Development

Run in live development mode with hot reload:

```bash
wails dev
```

The app will launch with a development server. Frontend changes will hot-reload automatically.

### Building

Build a production executable:

```bash
wails build
```

The executable will be created in `build/bin/`.

For specific platforms:

```bash
# Build for multiple platforms
wails build --platform windows/amd64,linux/amd64
```

## Usage

1. **Select Source Directories**: Add folders you want to backup
2. **Choose Destination**: Select where backups will be stored
3. **Configure Ignore Patterns**: Exclude files/folders (optional)
4. **Start Backup**: Click "Start Backup" to begin

### Default Ignore Patterns

The application suggests common patterns to ignore:
- `node_modules` - Node.js dependencies
- `.git`, `.svn`, `.hg` - Version control
- `.DS_Store`, `Thumbs.db` - System files
- `*.tmp`, `*.log`, `*.bak` - Temporary files
- `__pycache__`, `*.pyc` - Python cache

## Project Structure

```
bbackup/
├── backend/
│   ├── backup.go      # Backup orchestration engine
│   ├── cas.go         # Content-addressable storage
│   └── snapshot.go    # Snapshot management
├── frontend/
│   └── src/
│       ├── App.tsx    # Main React component
│       └── App.css    # Styling
├── app.go             # Wails integration layer
├── main.go            # Application entry point
└── wails.json         # Wails configuration
```

## How It Works

### Backup Process

1. **Initialization**: Load the latest snapshot (if exists)
2. **File Scanning**: Walk through source directories
3. **Change Detection**: Compare files against previous snapshot
4. **Content Storage**: Hash and store new/modified files in object store
5. **Snapshot Creation**: Save new manifest with file references
6. **Completion**: Report success and statistics

### Storage Format

**Object Store** (`objects/`):
```
objects/
├── ab/
│   └── cd/
│       └── abcdef123456... (file content)
```

**Snapshots** (`snapshots/`):
```json
{
  "id": "20231207120000",
  "timestamp": "2023-12-07T12:00:00Z",
  "source": ["/Users/john/Documents"],
  "files": {
    "report.pdf": {
      "hash": "abcdef123456...",
      "size": 1024000,
      "mode": 420,
      "mod_time": "2023-12-07T11:30:00Z"
    }
  }
}
```

## Configuration

The application stores the destination path in browser localStorage for persistence between sessions.

## Development Notes

### Current Status
- ✅ All core features implemented
- ✅ Go backend compiles successfully
- ⚠️ Wails build issue under investigation (see [walkthrough.md](file:///.gemini/antigravity/brain/769d7bfc-534f-4093-97b1-6b4164c794a1/walkthrough.md))

### Tech Stack
- **Backend**: Go 1.23.2
- **Frontend**: React 18 with TypeScript
- **Framework**: Wails v2.9.2
- **Build Tool**: Vite

## Contributing

This is a personal project, but suggestions and improvements are welcome.

## License

This project is provided as-is for educational and personal use.

## Roadmap

Future enhancements under consideration:
- [ ] Restore functionality
- [ ] Snapshot browsing and comparison
- [ ] Scheduled backups
- [ ] Compression options
- [ ] Encryption support
- [ ] Backup verification tools

## Support

For issues or questions, please refer to:
- [Wails Documentation](https://wails.io/docs/introduction)
- [Project Walkthrough](file:///.gemini/antigravity/brain/769d7bfc-534f-4093-97b1-6b4164c794a1/walkthrough.md)

---

Built with ❤️ using [Wails](https://wails.io)
