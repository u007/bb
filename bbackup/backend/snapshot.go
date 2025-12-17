package backend

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// FileEntry represents a file in the snapshot, mapping its relative path to its CAS hash.
type FileEntry struct {
	Path string `json:"path"` // Relative path from the source root
	Hash string `json:"hash"` // SHA-256 hash of the file content
	Size int64  `json:"size"` // Size of the file in bytes
	Mode fs.FileMode `json:"mode"` // File permissions and mode
	ModTime time.Time `json:"mod_time"` // Last modification time
}

// Snapshot represents a single point-in-time backup.
type Snapshot struct {
	ID        string                 `json:"id"`        // Unique ID for the snapshot (e.g., timestamp)
	Timestamp time.Time              `json:"timestamp"` // When the snapshot was created
	Source    []string               `json:"source"`    // Source directories that were backed up
	Files     map[string]*FileEntry `json:"files"`     // Map of relative path to FileEntry
}

// snapshotsDir returns the path to the directory where snapshots are stored.
func snapshotsDir(casBaseDir string) string {
	return filepath.Join(casBaseDir, "snapshots")
}

// snapshotFilePath returns the full path for a specific snapshot file.
func snapshotFilePath(casBaseDir, snapshotID string) string {
	return filepath.Join(snapshotsDir(casBaseDir), fmt.Sprintf("%s.json", snapshotID))
}

// LoadLatestSnapshot finds and loads the most recent snapshot from the backup destination.
// Returns nil, nil if no snapshots are found.
func LoadLatestSnapshot(casBaseDir string) (*Snapshot, error) {
	fmt.Fprintf(os.Stderr, "DEBUG: LoadLatestSnapshot started with casBaseDir=%s\n", casBaseDir)
	snapDir := snapshotsDir(casBaseDir)
	fmt.Fprintf(os.Stderr, "DEBUG: snapDir=%s\n", snapDir)
	
	// Check if directory exists before trying to read it
	fmt.Fprintf(os.Stderr, "DEBUG: About to stat snapshots directory\n")
	if stat, err := os.Stat(snapDir); os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "DEBUG: Snapshots directory does not exist, returning nil\n")
		return nil, nil // No snapshots directory, so no snapshots
	} else if err != nil {
		return nil, fmt.Errorf("failed to access snapshots directory %s: %w", snapDir, err)
	} else if !stat.IsDir() {
		return nil, fmt.Errorf("snapshots path %s exists but is not a directory", snapDir)
	}
	fmt.Fprintf(os.Stderr, "DEBUG: Snapshots directory exists and is valid\n")
	
	// Open directory with a file handle to ensure it's readable
	fmt.Fprintf(os.Stderr, "DEBUG: About to open snapshots directory\n")
	dir, err := os.Open(snapDir)
	if err != nil {
		return nil, fmt.Errorf("failed to open snapshots directory %s: %w", snapDir, err)
	}
	defer dir.Close()
	
	// Read directory entries
	fmt.Fprintf(os.Stderr, "DEBUG: About to read directory entries\n")
	fileInfos, err := dir.Readdir(-1)
	if err != nil {
		return nil, fmt.Errorf("failed to read snapshots directory entries %s: %w", snapDir, err)
	}
	fmt.Fprintf(os.Stderr, "DEBUG: Read %d directory entries\n", len(fileInfos))

	var latestSnapshotID string
	var latestTime time.Time

	var validEntries []fs.FileInfo
	for _, info := range fileInfos {
		if !strings.HasSuffix(info.Name(), ".json") {
			continue
		}
		validEntries = append(validEntries, info)
	}

	// Sort entries to find the latest snapshot by name (assuming timestamp-based names)
	sort.Slice(validEntries, func(i, j int) bool {
		return validEntries[i].Name() > validEntries[j].Name() // Descending order
	})

	for _, info := range validEntries {
		entryName := info.Name()
		
		id := strings.TrimSuffix(entryName, ".json")
		t, err := time.Parse("20060102150405", id) // Expecting format YYYYMMDDhhmmss
		if err != nil {
			// Log error but continue to find valid snapshots
			fmt.Fprintf(os.Stderr, "Warning: Invalid snapshot ID format '%s': %v\n", id, err)
			continue
		}

		if latestTime.IsZero() || t.After(latestTime) {
			latestTime = t
			latestSnapshotID = id
		}
	}

	if latestSnapshotID == "" {
		return nil, nil // No valid snapshots found
	}

	snapshot := &Snapshot{}
	filePath := snapshotFilePath(casBaseDir, latestSnapshotID)
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read latest snapshot file %s: %w", filePath, err)
	}

	if err := json.Unmarshal(data, snapshot); err != nil {
		return nil, fmt.Errorf("failed to unmarshal latest snapshot %s: %w", filePath, err)
	}

	return snapshot, nil
}

// LoadSnapshotFromFile loads a snapshot from a specific file path.
func LoadSnapshotFromFile(snapshotPath string) (*Snapshot, error) {
	fmt.Fprintf(os.Stderr, "DEBUG: LoadSnapshotFromFile loading from %s\n", snapshotPath)
	
	data, err := os.ReadFile(snapshotPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read snapshot file %s: %w", snapshotPath, err)
	}

	var snapshot Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return nil, fmt.Errorf("failed to unmarshal snapshot from %s: %w", snapshotPath, err)
	}

	fmt.Fprintf(os.Stderr, "DEBUG: Loaded snapshot with %d files\n", len(snapshot.Files))
	return &snapshot, nil
}

// SaveSnapshot writes a new snapshot to the backup destination.
func SaveSnapshot(casBaseDir string, snapshot *Snapshot) error {
	if snapshot.ID == "" {
		snapshot.ID = snapshot.Timestamp.Format("20060102150405")
	}

	snapDir := snapshotsDir(casBaseDir)
	if err := os.MkdirAll(snapDir, 0755); err != nil {
		return fmt.Errorf("failed to create snapshots directory %s: %w", snapDir, err)
	}

	filePath := snapshotFilePath(casBaseDir, snapshot.ID)
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal snapshot to JSON: %w", err)
	}

	// Write to a temporary file first, then rename for atomicity
	tempFilePath := filePath + ".tmp"
	if err := os.WriteFile(tempFilePath, data, 0644); err != nil {
		return fmt.Errorf("failed to write snapshot to temporary file %s: %w", tempFilePath, err)
	}

	if err := os.Rename(tempFilePath, filePath); err != nil {
		return fmt.Errorf("failed to rename temporary snapshot file %s to %s: %w", tempFilePath, filePath, err)
	}

	return nil
}

// StreamingSnapshotWriter allows writing snapshots incrementally without keeping everything in memory
type StreamingSnapshotWriter struct {
	file      *os.File
	writer    *bufio.Writer
	encoder   *json.Encoder
	header    Snapshot
	filesLeft int
	closed    bool
}

// NewStreamingSnapshotWriter creates a new streaming snapshot writer
func NewStreamingSnapshotWriter(casBaseDir, snapshotID string, sourcePaths []string) (*StreamingSnapshotWriter, error) {
	snapDir := filepath.Join(casBaseDir, "snapshots")
	if err := os.MkdirAll(snapDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create snapshots directory %s: %w", snapDir, err)
	}

	filePath := snapshotFilePath(casBaseDir, snapshotID)
	tempFilePath := filePath + ".tmp"
	
	file, err := os.Create(tempFilePath)
	if err != nil {
		return nil, fmt.Errorf("failed to create temporary snapshot file %s: %w", tempFilePath, err)
	}

	writer := bufio.NewWriter(file)
	encoder := json.NewEncoder(writer)
	
	// Write opening of snapshot object
	header := Snapshot{
		ID:        snapshotID,
		Timestamp: time.Now(),
		Source:    sourcePaths,
		Files:     make(map[string]*FileEntry), // Will be populated incrementally
	}

	if err := encoder.Encode(header); err != nil {
		file.Close()
		os.Remove(tempFilePath)
		return nil, fmt.Errorf("failed to write snapshot header: %w", err)
	}

	return &StreamingSnapshotWriter{
		file:    file,
		writer:  writer,
		encoder: encoder,
		header:  header,
		closed:  false,
	}, nil
}

// AddFile adds a file entry to the snapshot
func (ssw *StreamingSnapshotWriter) AddFile(entry *FileEntry) error {
	if ssw.closed {
		return fmt.Errorf("snapshot writer is closed")
	}
	
	// Add to in-memory map for final count
	ssw.header.Files[entry.Path] = entry
	ssw.filesLeft++
	
	// Write file entry as a separate line for easy parsing
	lineData, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("failed to marshal file entry: %w", err)
	}
	
	if _, err := ssw.writer.Write(lineData); err != nil {
		return fmt.Errorf("failed to write file entry: %w", err)
	}
	if _, err := ssw.writer.WriteString("\n"); err != nil {
		return fmt.Errorf("failed to write newline: %w", err)
	}
	
	return nil
}

// Close finalizes the snapshot and closes the file
func (ssw *StreamingSnapshotWriter) Close() error {
	if ssw.closed {
		return nil
	}
	
	// Flush any remaining data
	if err := ssw.writer.Flush(); err != nil {
		ssw.file.Close()
		return fmt.Errorf("failed to flush snapshot data: %w", err)
	}
	
	// Rewrite with complete snapshot (rebuild the file properly)
	finalData, err := json.MarshalIndent(ssw.header, "", "  ")
	if err != nil {
		ssw.file.Close()
		return fmt.Errorf("failed to marshal final snapshot: %w", err)
	}
	
	if _, err := ssw.file.Seek(0, io.SeekStart); err != nil {
		ssw.file.Close()
		return fmt.Errorf("failed to seek to start: %w", err)
	}
	
	if err := ssw.file.Truncate(int64(len(finalData))); err != nil {
		ssw.file.Close()
		return fmt.Errorf("failed to truncate file: %w", err)
	}
	
	if _, err := ssw.file.Write(finalData); err != nil {
		ssw.file.Close()
		return fmt.Errorf("failed to write final snapshot: %w", err)
	}
	
	// Get current file path before closing
	currentPath, err := filepath.Abs(ssw.file.Name())
	if err != nil {
		ssw.file.Close()
		return fmt.Errorf("failed to get current file path: %w", err)
	}
	
	if err := ssw.file.Close(); err != nil {
		return fmt.Errorf("failed to close snapshot file: %w", err)
	}
	
	// Rename from temporary to final name
	if strings.HasSuffix(currentPath, ".tmp") {
		finalPath := strings.TrimSuffix(currentPath, ".tmp")
		if err := os.Rename(currentPath, finalPath); err != nil {
			return fmt.Errorf("failed to rename snapshot file from %s to %s: %w", currentPath, finalPath, err)
		}
	}
	
	ssw.closed = true
	return nil
}

// BatchConfig defines configuration for batch processing
type BatchConfig struct {
	BatchSize    int           // Number of files to process before writing to disk
	MemoryLimit  int64         // Memory limit in bytes (approximate)
	FlushInterval time.Duration // Time interval to force flush
}

// DefaultBatchConfig returns sensible defaults for batch processing
func DefaultBatchConfig() BatchConfig {
	return BatchConfig{
		BatchSize:     5000,
		MemoryLimit:   200 * 1024 * 1024, // 200MB
		FlushInterval: 60 * time.Second,
	}
}

// MemoryStats provides memory usage information
type MemoryStats struct {
	Alloc      uint64 // Currently allocated memory
	TotalAlloc uint64 // Total allocated memory
	Sys        uint64 // System memory
	NumGC      uint32 // Number of GC runs
}

// GetMemoryStats returns current memory statistics
func GetMemoryStats() MemoryStats {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return MemoryStats{
		Alloc:      m.Alloc,
		TotalAlloc: m.TotalAlloc,
		Sys:        m.Sys,
		NumGC:      m.NumGC,
	}
}
