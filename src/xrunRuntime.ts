/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from 'events';
import { Subject } from 'await-notify';
import fs = require('fs');
import async = require('async');

export interface FileAccessor {
	isWindows: boolean;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, contents: Uint8Array): Promise<void>;
}

export interface IRuntimeBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

interface IRuntimeStepInTargets {
	id: number;
	label: string;
}

interface IRuntimeStackFrame {
	index: number;
	name: string;
	file: string;
	line: number;
	column?: number;
	instruction?: number;
}

interface IRuntimeStack {
	count: number;
	frames: IRuntimeStackFrame[];
}

export type IRuntimeVariableType = number | boolean | string | RuntimeVariable[];

export class RuntimeVariable {
	public reference?: number;

	public get value() {
		return this._value;
	}

	public set value(value: string){
		this._value = value;
	}

	constructor(public readonly name: string, private _value: string, public readonly type: string, public size?: number) {}
}

interface Word {
	name: string;
	line: number;
	index: number;
}

export function timeout(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export class XrunRuntime extends EventEmitter {

	// the initial (and one and only) file we are 'debugging'
	private _sourceFile: string = '';
	public get sourceFile() {
		return this._sourceFile;
	}

	private variables = new Map<string, RuntimeVariable[]>();

	private cwd: string = '';
	private stopOnEntry: boolean = true;

	private stdout_data: string[] = [];

	private launch_done = new Subject();
	private pending_data = new Subject();

	private sendOutputToClient: boolean = true;
	private largeExpectedOutput: boolean = false;

	// the contents (= lines) of the one and only file
	private sourceLines: string[] = [];

	private scopes: string[] = [];

	// This is the next line that will be 'executed'
	private _currentLine = 0;
	private get currentLine() {
		return this._currentLine;
	}
	private set currentLine(x) {
		this._currentLine = x;
	}
	private stepping: boolean = false;
	private stopHit: boolean = false;
	private stopEventString: 'stopOnBreakpoint' | 'stopOnDataBreakpoint' = 'stopOnBreakpoint';

	public instruction= 0;

	// maps from sourceFile to array of IRuntimeBreakpoint
	private breakPoints = new Map<string, IRuntimeBreakpoint[]>();
	private dataBreakpoints = new Array<string>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private breakpointId = 1;

	ls = require("child_process").spawn("/bin/sh", {
		shell: false,
	});

	readline = require("readline"); 
	readline_interface = this.readline.createInterface({ input: this.ls.stdout });

	constructor() {
		super();

		this.ls.stdout.setEncoding('utf-8');

		this.ls.stdout.on("data", (data: string) => {
			let lines = data.split(/\r?\n/);
			for(var line of lines){
				// This allows us to pinpoint the end of our desired output if it is large enough that it may not appear all in the same listener call
				// TODO: Benchmark the performance cost of having the endcmd flag always on for safety vs the "smart tradeoff" way
				if(this.largeExpectedOutput && line.includes('endcmd5443')){ 
					this.pending_data.notify();
					break;
				}
				line = line.replace(/^xcelium>/, ''); // Remove simulator output prefix from received line
				this.stdout_data.push(line);
			};
			if(!this.largeExpectedOutput)
				this.pending_data.notify();
		});

		this.readline_interface.on('line', (line: string) => {
			this.messageQueue.push(line, (error, line)=>{
				if(error){
					console.log(`An error occurred while processing line ${line}`);
				}
			});
		});
		
		this.ls.stderr.on("data", (data: string) => {
			console.log(`stderr: ${data}`);
		});
		
		this.ls.on('error', (error: { message: any; }) => {
			console.log(`error: ${error.message}`);
		});
		
		this.ls.on("close", (code: any) => {
			console.log(`child process exited with code ${code}`);
		});
	}

	messageQueue = async.queue((line: string, completed) => {
		if(line.search(/\$finish;/) !== -1){
			this.sendSimulatorTerminalCommand("exit");
		}
		else if(line.search('./run_sim.sh') !== -1){ // FIXME: Remove hardcoded way of detecting end of execution
			this.ls.kill();
			this.sendEvent('end');
		}
		else if(line.search('Created stop 1:') !== -1){
			// TODO: Change to be generic to non-UVM testbenches (and/or that don't include END-OF-BUILD stop)
			console.log("DETECTED INITIAL STOP");
			this.sendSimulatorTerminalCommand("run");
		}
		else if(line.search(/\(stop\s(\d+|[a-z_][a-z0-9_\[\]\.]*):/) !== -1){
			if(line.search(/\(stop\s\d+/) !== -1)
				this.stopEventString = 'stopOnBreakpoint';
			else
				this.stopEventString = 'stopOnDataBreakpoint';
			this.stopHit = true;
		}
		else if(this.stopHit && line.search(/(..\/)*[a-z_][a-z0-9_\/]*\.(sv|v|vams|vh|svh):\d+\s/) !== -1){
			this.stopHit = false;
			let ddot_index: number = line.search(/:\d+\s/);
			let bp_file_str: string = line.substring(0, ddot_index);
			let bp_line_str: string = line.substring(line.search(/:\d+\s/) + 1, line.indexOf(' ', ddot_index));
			this._sourceFile = this.cwd + '/' + bp_file_str;
			this.currentLine = parseInt(bp_line_str) - 1; // Editor lines are zero-based
			console.log("BREAKPOINT HIT");
			this.verifyBreakpoint(this._sourceFile, this.currentLine + 1);
			this.sendEvent(this.stopEventString);
		}
		else if(this.stepping && line.search(/(xcelium>\s)?\S+\.(sv|v|vams|vh|svh):\d+\s/) !== -1){
			let step_line_idx: number = line.search(/:\d+\s/);
			var m = /:\d+\s/.exec(line);
			let step_line_str: string = '';
			if(m){
				step_line_str = m[0].substring(1, m[0].length - 1);
			}
			let step_file_str: string = this.cwd + '/' + line.substring(line.substring(0, step_line_idx).search(/\S*$/));
			if(fs.existsSync(step_file_str)){
				this._sourceFile = step_file_str;
			}
			this.currentLine = parseInt(step_line_str) - 1;
			this.stepping = false;
			console.log("STOP ON STEP");
			this.sendEvent('stopOnStep');
		}
		else if(line.search(/End-of-build$/) !== -1){
			if(this.stopOnEntry){
				this.sendEvent('stopOnBreakpoint');
			}
			else{
				this.sendSimulatorTerminalCommand("run");
			}
			this.launch_done.notify();
		}
		else {
			if (this.sendOutputToClient == true)
				this.sendEvent("output", "out", line, "", 0, 0);
			else
				console.log(line);
		}

		completed(null);
	}, 1);


	/**
	 * Start executing the given program.
	 */
	public async start(cwd:string, program: string, args: string, stopOnEntry: boolean, debug: boolean): Promise<void> {
		this.cwd = cwd;
		this.stopOnEntry = stopOnEntry;
		
		if(this.cwd.length > 0)
			this.sendSimulatorTerminalCommand("cd " + this.cwd);

		// TODO: Make a setting for allowing generic arguments to specify interactive run config (linedebug etc. <-> -i)
		// This encompasses other genericities most likely
		if(debug) 
			this.sendSimulatorTerminalCommand("./" + program + " " + args + " -i");
		else
			this.sendSimulatorTerminalCommand("./" + program + " " + args);

		await this.launch_done.wait(5000);
	}

	/**
	 * Terminate Xcelium execution and release license
	 */
	public terminate(){
		this.sendSimulatorTerminalCommand("exit");
	}

	/**
	 * _Continue_: Resume execution flow until the next breakpoint is hit or the simulation ends.
	 */
	public continue() {
		console.log("RUNTIME.CONTINUE");
		this.sendSimulatorTerminalCommand("run");
	}

	/**
	 * _Step Over_: Run one behavioral statement, stepping over subprogram calls. If current execution is a Verilog process,
	 * stops at the next line of executable code within the current process.
	 */
	public step() {
		this.stepping = true;
		if(this._sourceFile.search(/\.svh?$/) !== -1){
			this.sendSimulatorTerminalCommand("run -next");
		} else {
			// -adjacent is only supported in verilog processes
			this.sendSimulatorTerminalCommand("run -adjacent"); 
		}
	}

	/**
	 * _Step Into_: Run one behavioral statement, stepping into subprogram calls. If current execution is a Verilog process,
	 * has the same effect as using _Step Over_
	 */
	public stepIn(targetId: number | undefined) {
		this.stepping = true;
		if(this._sourceFile.search(/\.svh?$/) !== -1){
			this.sendSimulatorTerminalCommand("run -step");
		} else {
			// -adjacent is only supported in verilog processes
			this.sendSimulatorTerminalCommand("run -adjacent"); 
		}
	}

	/**
	 * _Step Out_: Run until the current subprogram ends. If current execution is a Verilog process, will instead let the simulator
	 * stop at the next line of executable code, anywhere in the design hierarchy.
	 */
	public stepOut() {
		this.stepping = true;
		if(this._sourceFile.search(/\.svh?$/) !== -1){
			this.sendSimulatorTerminalCommand("run -return");
		} else {
			// -step lets simulator stop anywhere in the design hierarchy, which is probably the best expected behavior of "step out"
			// since -return will return an error if not inside a subprogram
			this.sendSimulatorTerminalCommand("run -step"); 
		}
	}

	// TODO: Support functionality
	// A possible way of doing this is using stop with -subprogram option (and potentially -delbreak 1)
	public getStepInTargets(frameId: number): IRuntimeStepInTargets[] {

		const line = this.getLine();
		const words = this.getWords(this.currentLine, line);

		// return nothing if frameId is out of range
		if (frameId < 0 || frameId >= words.length) {
			return [];
		}

		const { name, index  }  = words[frameId];

		// make every character of the frame a potential "step in" target
		return name.split('').map((c, ix) => {
			return {
				id: index + ix,
				label: `target: ${c}`
			};
		});
	}

	/**
	 * Returns the stack trace
	 */
	public async stack(startFrame: number, endFrame: number): Promise<IRuntimeStack> {

		let names: string[] = [];
		let files: string[] = [];
		let lines: number[] = [];
		
		await this.sendCommandWaitResponse("stack");	
		for(var i = 0; i < this.stdout_data.length; i++){
			let line = this.stdout_data.shift();
			if(line){
				if(line.search(/\d.*\sat\s/) !== -1){
					let name: string = line.substring(0, line.search(/\sat\s/));
					let line_idx: number = line.search(/:\d+$/);
					let line_str: string = line.substring(line_idx + 1);
					let file_str: string = line.substring(line.search(/\sat\s/) + 4, line_idx);
					names.push(name);
					if(file_str.substring(0, 3) == "../") {
						files.push(this.cwd.substring(0, this.cwd.lastIndexOf('/')) + file_str.substring(2));
					}
					else {
						files.push(file_str);
					}
					lines.push(Number(line_str));
				}
			}
		}
		const frames: IRuntimeStackFrame[] = [];
		for (let i = startFrame; i < Math.min(endFrame, names.length); i++) {

			const stackFrame: IRuntimeStackFrame = {
				index: i,
				name: names[i],	
				file: files[i],
				line: lines[i] - 1,
				column: 0, 
				instruction: undefined
			};

			frames.push(stackFrame);
		}
		// Extract scopes from the topmost stack frame
		this.scopes = [];
		if(names.length) {
			let fullscope: string = names[0].substring(names[0].lastIndexOf(' ') + 1);
			var regExp = /\./g;
			do {
				var m = regExp.exec(fullscope);
				if(m){
					this.scopes.push(fullscope.substring(0, m.index));
				}
			} while(m);
			this.scopes.push(fullscope);
		}

		return {
			frames: frames,
			count: names.length
		};
	}

	public getScopes(): string[]{
		return this.scopes;
	}

	private verifyBreakpoint(file: string, line: number){
		for(let [bp_file, bps] of this.breakPoints.entries()){
			// Only compare the filename because of possible relative path directory backtracks
			if(bp_file.substring(bp_file.lastIndexOf('/')) === file.substring(file.lastIndexOf('/'))){
				for(let bp of bps){
					if(bp.line == line){
						bp.verified = true;
						this.sendEvent('breakpointValidated', bp);
					}
				}
			}
		}
	}

	/*
	 * Determine possible column breakpoint positions for the given line.
	 * Here we return the start location of words with more than 8 characters.
	 */
	public getBreakpoints(path: string, line: number): number[] {
		//return this.getWords(line, this.getLine(line)).filter(w => w.name.length > 8).map(w => w.index);
		return [0];
	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public async setBreakPoint(path: string, line: number): Promise<IRuntimeBreakpoint | undefined> {		
		const bp: IRuntimeBreakpoint = { verified: false, line, id: this.breakpointId++ };
		let bps = this.breakPoints.get(path);

		// xrun format
		// Line breakpoint: stop -create -file <filepath> -line <line# (not zero aligned)> -all -name <id>
		/** TODO: Implement conditional breakpoints:
		 * Hit count: -skip <count>
		 * Condition: -condition <tcl_expression>	 
		 */
		let lines = await this.sendCommandWaitResponse("stop -create -file " + path + " -line " + line + " -all -name " + bp.id);
		if(lines.length > 0 && lines[0].search(/Created stop/) !== -1){
			bp.verified = true;
		}
		if (!bps) {
			bps = new Array<IRuntimeBreakpoint>();
			this.breakPoints.set(path, bps);
		}
		bps.push(bp);
		return bp;
	}

	public clearBreakpoints(path: string): void {
		const bps = this.breakPoints.get(path);
		if(bps){
			bps.forEach(bp => {
				this.sendSimulatorTerminalCommand("stop -delete " + bp.id);
			});
		}
		this.breakPoints.delete(path);
	}

	public async setDataBreakpoint(varName: string): Promise<boolean> {
		this.dataBreakpoints.push(varName);
		let lines = await this.sendCommandWaitResponse("stop -create -object " + varName + " -name " + varName);
		let error = false;
		lines.forEach((l: string) => {
			if(l.search(/\*E,STCRDP/) !== -1)
				error = true;
		});

		return !error;
	}

	public clearAllDataBreakpoints(): void {
		if(this.dataBreakpoints.length > 0){
			this.sendSimulatorTerminalCommand(`stop -delete ${this.dataBreakpoints.join(' ')}`);
			this.dataBreakpoints = [];
		}
	}

	private async parseSimulatorVariablesResponse(scope: string, mode: 'scope' | 'structuredVariable') : Promise<RuntimeVariable[]> {
		let sv_types: string[] = ['bit', 'byte', 'shortint', 'int', 'longint', 'reg', 'logic', 'integer', 
								'time', 'shortreal', 'real', 'realtime', 'string', 'enum', 'process'];
		let sv_partial_types: string[] = ['enum', 'reg', 'logic'];
		let sv_attributes: string[] = ['static', 'const', 'local', 'protected', 'rand', 'unsigned', 'signed'];
		let vars = new Array<RuntimeVariable>();
		let lines: string[] = [];
		let line: string | undefined = '';
		let type: string = '';
		let name: string = '';
		let value: string = '';
		let size: number = 1;
		let m;

		switch(mode){
			case 'scope':
				lines = await this.sendCommandWaitResponse("describe " + scope, 10000, true);
				while(lines.length > 0){
					line = lines.shift();
					if(line && line.search('=') !== -1){
						let name_idx: number = line.search(/\s[a-z_][a-z0-9_]*(\s\[.*\])?\s=/i);
						type = line.substring(0, name_idx).replace(new RegExp(`(${sv_attributes.join('|')})` , 'g'), '').trimLeft();
						name = line.substring(name_idx, line.search('=')).replace(/\s/g, '');
						value = line.substring(line.search('=') + 1).replace(/(\s+)?\(.*\)/g, '').trimLeft(); 
						size = 1;
						// TODO: Maybe add something for the derived class inheritance indicated at the end of the string

						if(!sv_types.includes(type) && !(new RegExp(`^(${sv_partial_types.join('|')})\\s`, 'g').test(type))){
							let lines_t = await this.sendCommandWaitResponse("describe " + type);
							let line_t = lines_t.shift();
							if(line_t){
								if(line_t.search(/typedef\s/) !== -1){
									type += ` (${line_t.substring(line_t.search(/typedef\s/) + 8).replace(/\s?{.*$/, '')})`;
								}
							}
						}

						if(name.search(/\[\$\]/) !== -1 || type.search(/\squeue/) !== -1){
							size = parseInt(value);
							value = "(" + size + ") " + type;
							if(type.search(/\squeue/) === -1)
								type += ' queue';
							name = name.replace(/\[\$\]/, '');
						}
						vars.push(new RuntimeVariable(name, value, type, size));
					}
				}
				break;
			case 'structuredVariable':
				// 1) Request for variable which returns array size and type
				lines = await this.sendCommandWaitResponse("describe " + scope);
				line = lines.shift();
				if(line){
					let _size: number = parseInt(line.substring(line.search('=') + 1).replace(/\s/g, ''));
					if(_size !== NaN){
						size = _size;
					}
					else{
						size = 0;
					}
					// 2) Parse type after variable keyword
					if((m = /variable\s[a-z_][a-z0-9_]*\s/.exec(line)) !== null){
						type = m[0].substring(9, m[0].length - 1);
					}
					else {
						type = "unknown";
					}
				}
				// 3) Request type
				if(type !== "unknown"){
					lines = await this.sendCommandWaitResponse("describe " + type);
					// 4) If its a struct (or a class eventually), xrunDebug.ts must properly page the children
					line = lines.shift();
					if(line && line.search(/struct/) !== -1){
						type += " struct";
					}
					if(size > 0){
						// Fetch each index of the array
						for(let i = 0; i < size; i++){
							lines = await this.sendCommandWaitResponse("describe " + scope + "[" + i + "]");
							line = lines.shift();
							if(line){
								name = scope + "[" + i + "]";
								if(type.search(/struct/) === -1){
									if((m = /variable\s[a-z_][a-z0-9_]*\s/.exec(line)) !== null){
										type = m[0].substring(9, m[0].length - 1);
									}
									value = line.substring(line.search('=') + 1);
								}
								vars.push(new RuntimeVariable(name, value, type, 0));
							}
						}
					}
					else {
						let names: string[] = [];
						let types: string[] = [];
						// Get all names and types from the type describe command
						while(lines.length > 0){
							line = lines.shift();
							if(line && line.search(/}/) === -1 && line.search(/\S/) !== -1){
								let end_of_type_idx = line.search(/\s[a-z_][a-z0-9_]*$/);
								types.push(line.substring(0, end_of_type_idx));
								names.push(line.substring(end_of_type_idx + 1));
							}
						}
						// Fetch values
						for(let i = 0; i < names.length; i++) {
							lines = await this.sendCommandWaitResponse("describe " + scope + "." + names[i]);
							line = lines.shift();
							if(line && line.search(/\*E,PVLIDX/) === -1){
								value = line.substring(line.search('=') + 1);
								vars.push(new RuntimeVariable(names[i], value, types[i], 0));
							}
						}
					}
				}
				break;
		}
		return vars;
	}

	public async fetchVariables(refName: string): Promise<RuntimeVariable[]> {
		let parserMode: 'scope' | 'structuredVariable' = this.scopes.includes(refName) ? 'scope' : 'structuredVariable';
		this.variables.delete(refName);
		
		return this.parseSimulatorVariablesResponse(refName, parserMode).then((vars: RuntimeVariable[]) => {
			this.variables.set(refName, vars);
			return vars;
		});
	}

	public async fetchVariable(name: string): Promise<RuntimeVariable | undefined> {
		let strs: string[] = [];
		let variable: RuntimeVariable | undefined = undefined;

		// Try to find variable in any existing scopes already fetched
		for(let [_, variables] of this.variables.entries()){
			variables.forEach(v => {
				if(v.name == name){
					variable = v;
				}
			});
		}
		// Manually fetch value
		await this.sendCommandWaitResponse("value -verbose " + name);
		let line = this.stdout_data.shift();
		if(line){
			strs = line.split('=');
			variable = new RuntimeVariable(name, strs[1], "unknown");
		}
		return variable;
	}

	public getVariable(name: string): RuntimeVariable | undefined {
		for(let [_, variables] of this.variables.entries()){
			for(const v of variables){
				if(v.name == name){
					return v;
				}
			}
		}
		return undefined;
	}

	public setVariable(name: string, value: string){
		this.sendSimulatorTerminalCommand('deposit ' + name + ' = #' + value + ' -after 0 -relative');
	}

	// private methods

	private getLine(line?: number): string {
		return this.sourceLines[line === undefined ? this.currentLine : line].trim();
	}

	private getWords(l: number, line: string): Word[] {
		// break line into words
		const WORD_REGEXP = /[a-z]+/ig;
		const words: Word[] = [];
		let match: RegExpExecArray | null;
		while (match = WORD_REGEXP.exec(line)) {
			words.push({ name: match[0], line: l, index: match.index });
		}
		return words;
	}

	private sendEvent(event: string, ... args: any[]): void {
		setTimeout(() => {
			this.emit(event, ...args);
		}, 0);
	}

	private sendSimulatorTerminalCommand(cmd: string, silent = false){
		this.ls.stdin.cork();
		this.ls.stdin.write(cmd + '\n');
		this.ls.stdin.uncork();
		if(!silent)
			console.log("Terminal command sent: " + cmd);
	}

	private async sendCommandWaitResponse(cmd: string, timeout:number = 5000, expensive: boolean = false): Promise<string[]>{
		this.stdout_data = [];
		this.sendOutputToClient = false;
		this.sendSimulatorTerminalCommand(cmd);
		this.largeExpectedOutput = expensive;
		if(expensive)
			this.sendSimulatorTerminalCommand('puts endcmd5443', true);
		await this.pending_data.wait(timeout);
		this.sendOutputToClient = true;
		return this.stdout_data;
	}
}
