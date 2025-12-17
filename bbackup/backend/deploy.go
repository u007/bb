package backend

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// DeploymentProgress tracks the progress of deployment operations
type DeploymentProgress struct {
	TotalFiles       int    `json:"totalFiles"`
	FilesProcessed   int    `json:"filesProcessed"`
	FilesSkipped     int    `json:"filesSkipped"`
	FilesCopied      int    `json:"filesCopied"`
	CurrentFile      string `json:"currentFile"`
	BytesCopied      int64  `json:"bytesCopied"`
	Status           string `json:"status"`
	Error            string `json:"error"`
}

// DeploymentConfig holds configuration for deployment operations
type DeploymentConfig struct {
	SnapshotPath     string `yaml:"snapshotPath"`
	TargetPath       string `yaml:"targetPath"`
	CASBaseDir       string `yaml:"casBaseDir"`
	PreserveModTimes bool   `yaml:"preserveModTimes"`
	UseHardLinks     bool   `yaml:"useHardLinks"`
	IgnorePatterns   []string `yaml:"ignorePatterns"`
}

// SmartDeploy performs intelligent deployment with file comparison
func SmartDeploy(ctx context.Context, config DeploymentConfig, progressCallback func(DeploymentProgress)) error {
	// Initialize progress
	progress := DeploymentProgress{
		Status: "Initializing...",
	}
	progressCallback(progress)

	// Load the snapshot
	snapshot, err := LoadSnapshotFromFile(config.SnapshotPath)
	if err != nil {
		progress.Status = "Failed"
		progress.Error = fmt.Sprintf("Failed to load snapshot: %v", err)
		progressCallback(progress)
		return fmt.Errorf("failed to load snapshot: %w", err)
	}

	progress.Status = "Planning deployment..."
	progressCallback(progress)

	// First pass: count files and plan deployment
	totalFiles := 0
	filesToProcess := make(map[string]*FileEntry)

	for relPath, fileEntry := range snapshot.Files {
		// Skip files matching ignore patterns
		if shouldIgnorePath(relPath, config.IgnorePatterns) {
			continue
		}

		totalFiles++
		filesToProcess[relPath] = fileEntry
	}

	progress.TotalFiles = totalFiles
	progress.Status = "Deploying files..."
	progressCallback(progress)

	// Process each file
	for relPath, fileEntry := range filesToProcess {
		select {
		case <-ctx.Done():
			progress.Status = "Cancelled"
			progress.Error = "Deployment cancelled by user"
			progressCallback(progress)
			return ctx.Err()
		default:
			// Continue
		}

		progress.CurrentFile = relPath
		progress.FilesProcessed++
		
		targetPath := filepath.Join(config.TargetPath, relPath)

		// Check if deployment is needed
		needsCopy, err := needsFileCopy(ctx, config.CASBaseDir, targetPath, fileEntry)
		if err != nil {
			progress.Status = "Failed"
			progress.Error = fmt.Sprintf("Error checking %s: %v", relPath, err)
			progressCallback(progress)
			return fmt.Errorf("error checking %s: %w", relPath, err)
		}

		if !needsCopy {
			// File is identical, skip it
			progress.FilesSkipped++
			progress.Status = "= " + filepath.Base(relPath) // Skipped indicator
			progressCallback(progress)
			continue
		}

		// Ensure target directory exists
		if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
			progress.Status = "Failed"
			progress.Error = fmt.Sprintf("Failed to create directory for %s: %v", relPath, err)
			progressCallback(progress)
			return fmt.Errorf("failed to create directory for %s: %w", relPath, err)
		}

		// Copy the file
		progress.Status = "→ " + filepath.Base(relPath) // Copy indicator
		progressCallback(progress)

		bytesCopied, err := deployFile(ctx, config, targetPath, fileEntry)
		if err != nil {
			if err == context.Canceled {
				progress.Status = "Cancelled"
				progress.Error = "Deployment cancelled during file copy"
				progressCallback(progress)
				return ctx.Err()
			}
			progress.Status = "Failed"
			progress.Error = fmt.Sprintf("Failed to deploy %s: %v", relPath, err)
			progressCallback(progress)
			return fmt.Errorf("failed to deploy %s: %w", relPath, err)
		}

		progress.FilesCopied++
		progress.BytesCopied += bytesCopied
		progressCallback(progress)
	}

	// Check for context cancellation before final operations
	select {
	case <-ctx.Done():
		progress.Status = "Cancelled"
		progress.Error = "Deployment cancelled during finalization"
		progressCallback(progress)
		return ctx.Err()
	default:
		// Continue
	}

	progress.Status = "Finalizing deployment..."
	progressCallback(progress)

	// TODO: Remove files from target that are not in snapshot (clean sync)
	// For now, we only deploy files present in the snapshot

	progress.Status = "Completed"
	progressCallback(progress)

	return nil
}

// needsFileCopy determines if a file needs to be copied based on content comparison
func needsFileCopy(ctx context.Context, casBaseDir, targetPath string, fileEntry *FileEntry) (bool, error) {
	// Check if target file exists
	targetInfo, err := os.Stat(targetPath)
	if err != nil {
		if os.IsNotExist(err) {
			return true, nil // File doesn't exist, needs copy
		}
		return false, err
	}

	// Quick size check first
	if targetInfo.Size() != fileEntry.Size {
		return true, nil // Different size, needs copy
	}

	// Check if modification times are the same (if we're preserving them)
	if !targetInfo.ModTime().Equal(fileEntry.ModTime) {
		// Times differ, but we should still check content to be sure
	}

	// Compare file hashes
	targetHash, err := computeFileHash(ctx, targetPath)
	if err != nil {
		return false, fmt.Errorf("failed to compute target file hash: %w", err)
	}

	// Get the source file hash from CAS
	sourceHash := fileEntry.Hash

	return targetHash != sourceHash, nil
}

// computeFileHash calculates SHA256 hash of a file
func computeFileHash(ctx context.Context, filePath string) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer file.Close()

	hasher := sha256.New()
	buf := make([]byte, 32*1024) // 32KB buffer

	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		default:
			// Continue
		}

		n, err := file.Read(buf)
		if n > 0 {
			if _, err := hasher.Write(buf[:n]); err != nil {
				return "", err
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
	}

	return fmt.Sprintf("%x", hasher.Sum(nil)), nil
}

// deployFile copies a single file using the optimal method
func deployFile(ctx context.Context, config DeploymentConfig, targetPath string, fileEntry *FileEntry) (int64, error) {
	// Get source file from CAS
	sourcePath := filepath.Join(config.CASBaseDir, fileEntry.Hash[:2], fileEntry.Hash)

	// If hard links are enabled and file sizes match, try to create a hard link
	if config.UseHardLinks {
		sourceInfo, err := os.Stat(sourcePath)
		if err == nil && sourceInfo.Size() == fileEntry.Size {
			// Remove target if it exists
			os.Remove(targetPath)
			
			if err := os.Link(sourcePath, targetPath); err == nil {
				// Hard link successful
				if config.PreserveModTimes {
					setFileModTime(targetPath, fileEntry.ModTime)
				}
				return fileEntry.Size, nil
			}
			// If hard link fails, fall back to copy
		}
	}

	// Fall back to regular copy
	return copyFilePreservingAttributes(ctx, sourcePath, targetPath, fileEntry, config.PreserveModTimes)
}

// copyFilePreservingAttributes copies a file while preserving attributes
func copyFilePreservingAttributes(ctx context.Context, src, dst string, fileEntry *FileEntry, preserveModTime bool) (int64, error) {
	srcFile, err := os.Open(src)
	if err != nil {
		return 0, err
	}
	defer srcFile.Close()

	// Remove destination if it exists
	os.Remove(dst)

	dstFile, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return 0, err
	}
	defer dstFile.Close()

	// Copy with context support
	var bytesCopied int64
	buf := make([]byte, 32*1024) // 32KB buffer

	for {
		select {
		case <-ctx.Done():
			return bytesCopied, ctx.Err()
		default:
			// Continue
		}

		nr, err := srcFile.Read(buf)
		if nr > 0 {
			nw, err := dstFile.Write(buf[:nr])
			if nw > 0 {
				bytesCopied += int64(nw)
			}
			if err != nil {
				return bytesCopied, err
			}
			if nr != nw {
				return bytesCopied, io.ErrShortWrite
			}
		}
		if err != nil {
			if err == io.EOF {
				break
			}
			return bytesCopied, err
		}
	}

	// Preserve modification time if requested
	if preserveModTime {
		if err := setFileModTime(dst, fileEntry.ModTime); err != nil {
			return bytesCopied, fmt.Errorf("failed to preserve modification time: %w", err)
		}
	}

	return bytesCopied, nil
}

// setFileModTime sets the modification time of a file
func setFileModTime(filePath string, modTime time.Time) error {
	return os.Chtimes(filePath, time.Now(), modTime)
}

// shouldIgnorePath checks if a path matches any of the ignore patterns
func shouldIgnorePath(path string, patterns []string) bool {
	for _, pattern := range patterns {
		if matched := matchPattern(pattern, path); matched {
			return true
		}
	}
	return false
}

// matchPattern performs simple wildcard matching for ignore patterns
func matchPattern(pattern, path string) bool {
	// Simple implementation - can be enhanced with proper glob patterns
	if pattern == "" {
		return false
	}
	
	// Convert to lowercase for case-insensitive matching
	patternLower := filepath.Base(pattern)
	pathLower := filepath.Base(path)
	
	return patternLower == pathLower
}