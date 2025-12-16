package backend

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
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
	snapDir := snapshotsDir(casBaseDir)
	
	// Check if directory exists before trying to read it
	if stat, err := os.Stat(snapDir); os.IsNotExist(err) {
		return nil, nil // No snapshots directory, so no snapshots
	} else if err != nil {
		return nil, fmt.Errorf("failed to access snapshots directory %s: %w", snapDir, err)
	} else if !stat.IsDir() {
		return nil, fmt.Errorf("snapshots path %s exists but is not a directory", snapDir)
	}
	
	// Open directory with a file handle to ensure it's readable
	dir, err := os.Open(snapDir)
	if err != nil {
		return nil, fmt.Errorf("failed to open snapshots directory %s: %w", snapDir, err)
	}
	defer dir.Close()
	
	// Read directory entries
	entries, err := dir.Readdirnames(-1)
	if err != nil {
		return nil, fmt.Errorf("failed to read snapshots directory entries %s: %w", snapDir, err)
	}

	var latestSnapshotID string
	var latestTime time.Time

	// Sort entries to find the latest snapshot by name (assuming timestamp-based names)
	sort.Strings(entries)

	for _, entryName := range entries {
		if !strings.HasSuffix(entryName, ".json") {
			continue
		}
		
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
