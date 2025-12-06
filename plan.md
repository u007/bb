# Backup Application Development Plan

## Project Goal

To create a cross-platform backup application with a UI that allows users to set up backups, automatically proposes backup paths, saves destination information, and uses an efficient, Time Machine-like versioning system (Content-Addressable Storage) for various file systems (exFAT, APFS, ext4). The core logic will be written in Go, and the UI will be built with Wails using React/TypeScript.

## Architecture and Technology

### 1. Frontend (UI): Wails (v2) with React/TypeScript

- **Framework:** Wails v2
- **UI Library:** React
- **Language:** TypeScript
- **Reasoning:** Provides a native desktop application experience across macOS, Windows, and Linux, leveraging modern web development for the UI while integrating seamlessly with the Go backend.

### 2. Backend (Core Logic): Go

- **Language:** Go
- **Reasoning:** High performance, excellent concurrency features for efficient file processing, and strong cross-compilation capabilities, making it ideal for a system-level tool.

### 3. Core Backup & Versioning Strategy: Content-Addressable Storage (CAS)

- **Concept:** Instead of direct file copies or hard links (which are not universally supported by all target filesystems like exFAT), we will use a Content-Addressable Storage model.
- **Mechanism:**
  1.  **Object Store:** A dedicated directory (`objects/`) on the destination drive will store unique file contents.
  2.  **Hashing:** Files are broken down (or treated as whole files), and their content's SHA-256 hash determines their name in the `objects/` store. This ensures content uniqueness.
  3.  **Snapshots:** Each backup operation creates a new, lightweight "snapshot" manifest (e.g., a JSON file). This manifest describes the directory structure and links file paths to their corresponding content hashes in the `objects/` store.
- **Benefits:**
  - **Cross-Filesystem Compatibility:** Works seamlessly on exFAT, APFS, ext4, NTFS, etc., as it doesn't rely on filesystem-specific features like hard links.
  - **Space Efficiency:** Only unique content chunks are stored. If a file remains unchanged across backups, only its hash reference is added to the new snapshot, not a new copy of its data.
  - **Performance (Rsync-like):** Comparison of files is done via hashes, ensuring only new or modified data is processed and stored.
  - **Data Integrity:** Hashes inherently provide data integrity checks.

## Detailed Implementation Steps (To-Do List)

1.  **Project Scaffolding:**
    - [x] Initialize a new Wails project (`bbackup`) with a Go backend and a React/TypeScript frontend.
2.  **UI - Core Components:**
    - [x] Design and implement the main application layout.
    - [x] Create components for displaying and managing source directories (add, remove).
    - [x] Develop a component for selecting the backup destination drive.
    - [x] Implement a "Start Backup" button and a status/logging area.
3.  **Backend - Source Path Detection:**
    - [x] Develop Go functions to automatically identify and propose common user directories for backup (e.g., home directory, Documents, Pictures).
4.  **Backend - Core CAS Logic:**
    - [x] Implement Go functions for computing SHA-256 hashes of file contents.
    - [x] Create functions to store file content in the `objects/` directory based on its hash.
    - [x] Implement functions to retrieve file content from the `objects/` directory.
5.  **Backend - Snapshot Management:**
    - [x] Develop Go structures and functions to represent and manage backup snapshots (manifests).
    - [x] Implement logic to read and write snapshot metadata (e.g., JSON files) to the destination.
6.  **Backend - The Backup/Sync Process:**
    - [x] Implement the core backup engine in Go:
      - [x] Iterate through selected source directories.
      - [x] Compare current source files against the latest snapshot's manifest.
      - [x] For new or modified files, calculate hash, store content in `objects/`, and update the new snapshot's manifest.
      - [x] For deleted files, mark them as such in the new snapshot (or remove from manifest if desired).
      - [x] Atomically save the new snapshot manifest.
7.  **UI-Backend Integration:**
    - [x] Connect frontend React components to backend Go functions using Wails' IPC.
    - [x] Display source suggestions in the UI.
    - [x] Trigger backup operations from the UI.
    - [x] Stream real-time backup progress and logs to the UI.
    - [x] Persist the chosen destination path between application runs.
8.  **Error Handling & Robustness:**
    - [x] Implement comprehensive error handling throughout the application.
    - [x] Ensure robust handling of I/O operations and filesystem interactions.
    - [x] Made CASRoot dynamic, added detailed progress reporting to UI.
9.  **Build and Package:**
    - [x] Configure Wails to build and package the application for macOS, Windows, and Linux.
10. **Implement Ignore Functionality:**
    - [x] Add UI for managing ignored files/folders/patterns.
    - [x] Implement backend logic to propose common ignore patterns.
    - [x] Update the backup process to skip ignored items.

## Build and Run Instructions

The core development of the cross-platform backup application is now complete. The final step is to build and package the application for your desired operating systems.

Wails simplifies this process significantly. You can build the application for your current platform (or specify targets for other platforms) using the `wails build` command.

To build the application for your current operating system, navigate to the `bbackup` directory in your terminal and run:

```bash
wails build
```

This will create an executable in the `build/bin` directory within your `bbackup` project.

If you wish to build for specific platforms (e.g., Windows, Linux), you can use the `--platform` flag:

```bash
wails build --platform windows/amd64,linux/amd64
```

For more options and detailed build configurations, please refer to the Wails documentation on building applications.
