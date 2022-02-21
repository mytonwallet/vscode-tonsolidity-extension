'use strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { errorToDiagnostic } from './solErrorsToDiagnostics';
import { Terminal, Component } from 'everdev';
import { ContractCollection } from './model/contractsCollection';
import { initialiseProject } from './projectService';
import { DebugConsoleMode } from 'vscode';

const TOOL_FOLDER_NAME = "solidity";

const components = {
    compiler: new Component(TOOL_FOLDER_NAME, "solc", {
        isExecutable: true,
    }),

    linker: new Component(TOOL_FOLDER_NAME, "tvm_linker", {
        isExecutable: true,
        resolveVersionRegExp: /[^0-9]*([0-9.]+)/,
    }),

    stdlib: new class extends Component {
        getSourceName(version: string): string {
            return `${this.name}_${version.split(".").join("_")}.tvm.gz`;
        }

        async resolveVersion(downloadedVersion: string): Promise<string> {
            return downloadedVersion;
        }

        async loadAvailableVersions(): Promise<string[]> {
            return components.compiler.loadAvailableVersions();
        }
    }(TOOL_FOLDER_NAME, "stdlib_sol", {
        targetName: "stdlib_sol.tvm",
    }),
};

export class SolcCompiler {

    public rootPath: string;
    public _everdevTerminal: Terminal;
    private everdevTerminalOutput = [];
    
    constructor(rootPath: string) {
        this.rootPath = rootPath;
    }

    public isRootPathSet(): boolean {
        return typeof this.rootPath !== 'undefined' && this.rootPath !== null;
    }
   
    public everdevTerminal(): Terminal {
        if (!this._everdevTerminal) {
            this._everdevTerminal = {
                log: (...args: any[]) => {
                    this.everdevTerminalOutput.push(args.map((x) => `${x}`).join(""));
                },
                writeError: (text: string) => {
                    this.everdevTerminalOutput.push(text);
                },
                write: (text: string) => {
                    this.everdevTerminalOutput.push(text);
                },
            };
        }
        return this._everdevTerminal;
    }

    private async runCompilation(terminal: Terminal, args: {
        file: string,
        outputDir?: string,
    }): Promise<any[]> {
        const ext = path.extname(args.file);
        if (ext !== ".tsol" && ext !== ".sol") {
            terminal.log(`Choose TON solidity source file (.tsol or .sol).`);
            return;
        }
        await Component.ensureInstalledAll(terminal, components);
        const fileDir   = path.dirname(args.file);
        const fileName  = path.basename(args.file);
        const outputDir = path.resolve(args.outputDir ?? fileDir);
        const tvcName   = path.resolve(outputDir, fileName.replace(/\.[^/.]+$/, ".tvc"));
        const codeName  = path.resolve(outputDir, fileName.replace(/\.[^/.]+$/, ".code"));
        const compiler  = new Component("solidity", "solc", {
            isExecutable: true,
        });
        try {
            await compiler.silentRun(terminal, fileDir, ["-o", outputDir, fileName]);
        } catch(e) {
            //console.log(JSON.stringify(e));
        }
        const linker = new Component("solidity", "tvm_linker", {
            isExecutable: true,
            resolveVersionRegExp: /[^0-9]*([0-9.]+)/,
        });
        const stdlib = new class extends Component {
            getSourceName(version: string): string {
                return `${this.name}_${version.split(".").join("_")}.tvm.gz`;
            }
    
            async resolveVersion(downloadedVersion: string): Promise<string> {
                return downloadedVersion;
            }
    
            async loadAvailableVersions(): Promise<string[]> {
                return compiler.loadAvailableVersions();
            }
        }("solidity", "stdlib_sol", {
            targetName: "stdlib_sol.tvm",
        });
        try {
            const linkerOut = await linker.silentRun(
                terminal,
                fileDir,
                ["compile", codeName, "--lib", stdlib.path()],
            );
            const generatedTvcName = `${/Saved contract to file (.*)$/mg.exec(linkerOut)?.[1]}`;
            fs.renameSync(path.resolve(fileDir, generatedTvcName), path.resolve(outputDir, tvcName));
            fs.unlinkSync(path.resolve(fileDir, codeName));
        } catch(e) {
            //console.log(JSON.stringify(e));
        }
        return this.everdevTerminalOutput;
    }

    public async compile(contracts: any): Promise<any> {
        let rawErrors = [];
        this.everdevTerminalOutput = [];
        for (let fileNameId in contracts.sources) {
            //need to create temporary file and remove after saving
            let fileName  = path.basename(fileNameId);
            if (fileName.substring(0,1) == '~') { // we don't need to compile temp file
                continue;
            }
            let fileDir = path.dirname(fileNameId);
                fileDir = fileDir.replace(/\/contracts\//, "/.temp/");
                fileDir = fileDir.replace(/\\contracts\\/, "\\.temp\\");
                fileDir = fileDir.replace(/\/contracts$/, "/.temp");
                fileDir = fileDir.replace(/\\contracts$/, "\\.temp");

            if (!fs.existsSync(fileDir)) {
                fs.mkdirSync(fileDir, { recursive: true });
            }
            fileName = path.resolve(fileDir, "~" + fileName);
            //need to replace the import definition on the file path with the most new content
            contracts.sources[fileNameId].content = contracts.sources[fileNameId].content.replace(/(import +['"].*(?![^\/])\/)([^\.]*)(\.[^'"]*['"];)/g, (source, p1, p2, p3) => {
                if (p1.indexOf('node_modules') != -1) {
                    return source;
                } else {
                    return `${p1}~${p2}${p3}`
                }
            });

            try {
                fs.writeFileSync(fileName, contracts.sources[fileNameId].content, { flag: 'w' });
            } catch (err) {
                //console.error(JSON.stringify(err));
            }
            rawErrors = await this.runCompilation(this.everdevTerminal(), {"file": fileName});
        }
        let outputErrors = [];

        if (os.platform() == 'win32') {
            outputErrors = this.parseErrorsWin32(rawErrors);
        } else {
            outputErrors = this.parseErrorsOtherPlatforms(rawErrors);
        }
        return outputErrors;
    }

    private parseErrorsWin32(rawErrors) {
        let outputErrors = [];
        for (let i in rawErrors) {
            let errors = rawErrors[i].split(/\r\n\r\n/g);
            for(let j in errors) {
                let er = errors[j].split(/\r\n/g);
                if (er.length >= 5) {
                    const _er = er[0].split(/:/g);
                    const severity = _er[0];
                    const message = _er[1];
                    let sprep1 = er[1].replace(/ --> /g, "");
                    let prep1 = [];
                    for ( let k = 2; k >= 0 ; k--) {
                        prep1.push(sprep1.substr(sprep1.lastIndexOf(":")+1));
                        sprep1 = sprep1.substr(0, sprep1.lastIndexOf(":"));
                    }
                    const file = String(sprep1).trim();
                    let fileDir = path.dirname(file);
                        fileDir = fileDir.replace(/\/.temp\//, "/contracts/");
                        fileDir = fileDir.replace(/\/.temp$/, "/contracts");

                    let fileName: string;
                    if (fileDir == ".") {
                        fileName  = file.substring(0, 1) === '~' ? file.substring(1): file;
                    } else {
                        fileName = String(path.basename(file)).trim();
                        //here 2 cases: from lint without ~ and from compiler with ~
                        fileName = fileName.substring(0, 1) === '~' ? fileName.substring(1): fileName;
                    }

                    const line = prep1[2];
                    const column = prep1[1];
                    outputErrors.push({"severity": severity, "message": message, "file": fileName, "length": (er[4].match(/\^/g)||[]).length, "line": line, "column": column});
                }
            }
        }
        return outputErrors;
    }

    private parseErrorsOtherPlatforms(rawErrors) {
        let outputErrors = [];
        for (let i in rawErrors) {
            let er = rawErrors[i].split(/\n/g);
            if (er.length >= 5) {
                const _er = er[0].split(/:/g);
                const severity = _er[0];
                const message = _er[1];
                let sprep1 = er[1].replace(/  --> /g, "");
                let prep1 = [];
                for( let k = 2; k >= 0 ; k--) {
                    prep1.push(sprep1.substring(sprep1.lastIndexOf(":")+1));
                    sprep1 = sprep1.substring(0, sprep1.lastIndexOf(":"));
                }
                const file = sprep1;
                const fileDir = path.dirname(file);
                      fileDir.replace("/.temp/", "/contracts/");
                let fileName: string;
                if (fileDir == ".") {
                    fileName  = file.substring(0, 1) === '~' ? file.substring(1): file;
                } else {
                    fileName = path.basename(file);
                    fileName = fileName.substring(0, 1) === '~' ? fileName.substring(1): fileName;
                    fileName = path.resolve(fileDir, fileName);
                }
                const line = prep1[2];
                const column = prep1[1];
                outputErrors.push({"severity": severity, "message": message, "file": fileName, "length": (er[4].match(/\^/g)||[]).length, "line": line, "column": column});
            }
        }
        return outputErrors;
    }

    public async compileSolidityDocumentAndGetDiagnosticErrors(filePath: string, documentText: string,
        packageDefaultDependenciesDirectory: string, packageDefaultDependenciesContractsDirectory: string) {
        if (this.isRootPathSet()) {
            const contracts = new ContractCollection();
            contracts.addContractAndResolveImports(
                filePath,
                documentText,
                initialiseProject(this.rootPath, packageDefaultDependenciesDirectory, packageDefaultDependenciesContractsDirectory));
            const contractsForCompilation = contracts.getDefaultContractsForCompilationDiagnostics();
            contractsForCompilation.settings = null;
            const output = await this.compile(contractsForCompilation);
            if (output) {
                return output
                    .map(error => errorToDiagnostic(error));
            }
        } else {
            const contract = {};
            contract[filePath] = documentText;
            const output = await this.compile({ sources: contract });
            if (output) {
                return output.map((error) => errorToDiagnostic(error));
            }
        }
        return [];
    }

}

