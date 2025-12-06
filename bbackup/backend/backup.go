package backend

import (
	"context"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
	"time"
)

// BackupProgress represents the progress of a backup operation
type BackupProgress struct {
	TotalFiles       int    `json:"totalFiles"`
	FilesProcessed   int    `json:"filesProcessed"`
	CurrentFile      string `json:"currentFile"`
	BytesTransferred int64  `json:"bytesTransferred"`
	TotalBytes       int64  `json:"totalBytes"`
	Status           string `json:"status"` // e.g., "Scanning", "Hashing", "Storing", "Completed", "Failed"
	Error            string `json:"error"`
}

// ProgressCallback is a function type for reporting backup progress.
type ProgressCallback func(progress BackupProgress)

// RunBackup orchestrates the entire backup process for specified source paths to a CAS base directory.
// It reports progress via the provided ProgressCallback.
func RunBackup(ctx context.Context, casBaseDir string, sourcePaths []string, ignorePatterns []string, progressCallback ProgressCallback) error {
	var currentProgress BackupProgress
	updateProgress := func() {
		if progressCallback != nil {
			progressCallback(currentProgress)
		}
	}

	currentProgress.Status = "Initializing"
	updateProgress()

	// 1. Load the latest snapshot
	latestSnapshot, err := LoadLatestSnapshot(casBaseDir)
	if err != nil {
		currentProgress.Status = "Failed"
		currentProgress.Error = fmt.Sprintf("Failed to load latest snapshot: %v", err)
		updateProgress()
		return fmt.Errorf("failed to load latest snapshot: %w", err)
	}

	newSnapshot := &Snapshot{
		Timestamp: time.Now(),
		Source:    sourcePaths,
		Files:     make(map[string]*FileEntry),
	}

	fileCount := 0
	// First pass: count files and estimate total size (optional, for more accurate progress)
	// For simplicity, we'll iterate and count on the fly for now.
	// A more robust solution might do a pre-scan to get TotalFiles and TotalBytes.

	// For each source path, walk through files and process them
	for _, sourcePath := range sourcePaths {
		absSourcePath, err := filepath.Abs(sourcePath)
		if err != nil {
			currentProgress.Status = "Failed"
			currentProgress.Error = fmt.Sprintf("Failed to get absolute path for source %s: %v", sourcePath, err)
			updateProgress()
			return fmt.Errorf("failed to get absolute path for source %s: %w", sourcePath, err)
		}

		err = filepath.WalkDir(absSourcePath, func(path string, d fs.DirEntry, err error) error {
			// Check for context cancellation
			select {
			case <-ctx.Done():
				return ctx.Err() // Propagate cancellation error
			default:
				// Continue
			}

			if err != nil {
				// Log error but attempt to continue for other files if possible
				currentProgress.Status = "Scanning (with errors)"
				currentProgress.Error = fmt.Sprintf("Error accessing %s: %v", path, err)
				updateProgress()
				return nil // Don't return error here to allow WalkDir to continue
			}

			// --- IGNORE LOGIC ---
			for _, pattern := range ignorePatterns {
				// Check for absolute path match
				if filepath.IsAbs(pattern) && path == pattern {
					if d.IsDir() {
						return filepath.SkipDir
					}
					return nil // Skip this file
				}

				// Check for glob pattern match on the name
				match, _ := filepath.Match(pattern, d.Name())
				if match {
					if d.IsDir() {
						return filepath.SkipDir
					}
					return nil // Skip this file
				}
			}

			// Exclude the backup destination directory itself
			// This check assumes casBaseDir is an absolute path.
			// It's crucial that casBaseDir is passed as an absolute path from the frontend.
			if strings.HasPrefix(path, casBaseDir) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}

			if d.IsDir() {
				return nil // Skip directories after ignore checks
			}

			// Get relative path from the source root
			relPath, err := filepath.Rel(absSourcePath, path)
			if err != nil {
				currentProgress.Status = "Failed"
				currentProgress.Error = fmt.Sprintf("Failed to get relative path for %s: %v", path, err)
				updateProgress()
				return fmt.Errorf("failed to get relative path for %s: %w", path, err)
			}
			// Use forward slashes for consistency regardless of OS
			relPath = filepath.ToSlash(relPath)

			fileInfo, err := d.Info()
			if err != nil {
				currentProgress.Status = "Failed"
				currentProgress.Error = fmt.Sprintf("Failed to get file info for %s: %v", path, err)
				updateProgress()
				return fmt.Errorf("failed to get file info for %s: %w", path, err)
			}

			fileCount++
			currentProgress.TotalFiles = fileCount // Update total files found so far
			currentProgress.FilesProcessed++
			currentProgress.CurrentFile = path
			currentProgress.Status = "Processing file"
			updateProgress()

			currentFileEntry := &FileEntry{
				Path:    relPath,
				Size:    fileInfo.Size(),
				Mode:    fileInfo.Mode(),
				ModTime: fileInfo.ModTime(),
			}

			// Compare with latest snapshot
			var fileHash string
			var contentStored bool
			if latestSnapshot != nil {
				if prevEntry, ok := latestSnapshot.Files[relPath]; ok {
					if prevEntry.Size == currentFileEntry.Size &&
						prevEntry.ModTime.Equal(currentFileEntry.ModTime) {
						fileHash = prevEntry.Hash // Use previous hash, no need to re-store
						contentStored = true
					}
				}
			}

			if !contentStored { // File is new or modified, or not in previous snapshot
				currentProgress.Status = "Storing content for " + filepath.Base(path)
				updateProgress()
				hash, err := StoreFileContent(casBaseDir, path)
				if err != nil {
					currentProgress.Status = "Failed"
					currentProgress.Error = fmt.Sprintf("Failed to store content for %s: %v", path, err)
					updateProgress()
					return fmt.Errorf("failed to store content for %s: %w", path, err)
				}
				fileHash = hash
			}
			currentFileEntry.Hash = fileHash
			newSnapshot.Files[relPath] = currentFileEntry
			currentProgress.BytesTransferred += fileInfo.Size() // Accumulate bytes
			updateProgress()

			return nil
		})
		if err != nil {
			if err == context.Canceled { // Check if the error was due to context cancellation
				currentProgress.Status = "Cancelled"
				currentProgress.Error = "Backup cancelled by user"
				updateProgress()
				return err // Propagate cancellation error
			}
			currentProgress.Status = "Failed"
			currentProgress.Error = fmt.Sprintf("Error walking source path %s: %v", sourcePath, err)
			updateProgress()
			return fmt.Errorf("error walking source path %s: %w", sourcePath, err)
		}
	}

	currentProgress.Status = "Saving snapshot"
	updateProgress()

	// 2. Save the new snapshot
	if err := SaveSnapshot(casBaseDir, newSnapshot); err != nil {
		currentProgress.Status = "Failed"
		currentProgress.Error = fmt.Sprintf("Failed to save new snapshot: %v", err)
		updateProgress()
		return fmt.Errorf("failed to save new snapshot: %w", err)
	}

	currentProgress.Status = "Completed"
	updateProgress()
	return nil
}
