export namespace backend {
	
	export class BackupProgress {
	    totalFiles: number;
	    filesProcessed: number;
	    currentFile: string;
	    bytesTransferred: number;
	    totalBytes: number;
	    status: string;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new BackupProgress(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.totalFiles = source["totalFiles"];
	        this.filesProcessed = source["filesProcessed"];
	        this.currentFile = source["currentFile"];
	        this.bytesTransferred = source["bytesTransferred"];
	        this.totalBytes = source["totalBytes"];
	        this.status = source["status"];
	        this.error = source["error"];
	    }
	}
	export class DeploymentConfig {
	    SnapshotPath: string;
	    TargetPath: string;
	    CASBaseDir: string;
	    PreserveModTimes: boolean;
	    UseHardLinks: boolean;
	    IgnorePatterns: string[];
	
	    static createFrom(source: any = {}) {
	        return new DeploymentConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.SnapshotPath = source["SnapshotPath"];
	        this.TargetPath = source["TargetPath"];
	        this.CASBaseDir = source["CASBaseDir"];
	        this.PreserveModTimes = source["PreserveModTimes"];
	        this.UseHardLinks = source["UseHardLinks"];
	        this.IgnorePatterns = source["IgnorePatterns"];
	    }
	}
	export class DeploymentProgress {
	    totalFiles: number;
	    filesProcessed: number;
	    filesSkipped: number;
	    filesCopied: number;
	    currentFile: string;
	    bytesCopied: number;
	    status: string;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new DeploymentProgress(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.totalFiles = source["totalFiles"];
	        this.filesProcessed = source["filesProcessed"];
	        this.filesSkipped = source["filesSkipped"];
	        this.filesCopied = source["filesCopied"];
	        this.currentFile = source["currentFile"];
	        this.bytesCopied = source["bytesCopied"];
	        this.status = source["status"];
	        this.error = source["error"];
	    }
	}

}

export namespace main {
	
	export class BackupConfig {
	    id: string;
	    name: string;
	    sourcePaths: string[];
	    destinationPath: string;
	    ignorePatterns: string[];
	
	    static createFrom(source: any = {}) {
	        return new BackupConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.sourcePaths = source["sourcePaths"];
	        this.destinationPath = source["destinationPath"];
	        this.ignorePatterns = source["ignorePatterns"];
	    }
	}
	export class BackupState {
	    id: string;
	    status: string;
	    progress: backend.BackupProgress;
	    config: BackupConfig;
	    // Go type: time
	    startTime: any;
	    // Go type: time
	    lastUpdateTime: any;
	    processedFiles: Record<string, boolean>;
	    currentFile: string;
	
	    static createFrom(source: any = {}) {
	        return new BackupState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.status = source["status"];
	        this.progress = this.convertValues(source["progress"], backend.BackupProgress);
	        this.config = this.convertValues(source["config"], BackupConfig);
	        this.startTime = this.convertValues(source["startTime"], null);
	        this.lastUpdateTime = this.convertValues(source["lastUpdateTime"], null);
	        this.processedFiles = source["processedFiles"];
	        this.currentFile = source["currentFile"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class DeploymentState {
	    id: string;
	    status: string;
	    progress: backend.DeploymentProgress;
	    config: backend.DeploymentConfig;
	    // Go type: time
	    startTime: any;
	    // Go type: time
	    lastUpdateTime: any;
	
	    static createFrom(source: any = {}) {
	        return new DeploymentState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.status = source["status"];
	        this.progress = this.convertValues(source["progress"], backend.DeploymentProgress);
	        this.config = this.convertValues(source["config"], backend.DeploymentConfig);
	        this.startTime = this.convertValues(source["startTime"], null);
	        this.lastUpdateTime = this.convertValues(source["lastUpdateTime"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

