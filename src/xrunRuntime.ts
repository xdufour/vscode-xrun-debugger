/*---------------------------------------------------------
 * xrunRuntime.ts
 * TODO:
 * - Logpoints
 * - Step in target
 * - Target console setting
 * - UVM configurations settings (log level, xrun arguments, etc.)
 *--------------------------------------------------------*/

import { EventEmitter } from 'events';
import { Subject } from 'await-notify';
import fs = require('fs');
import async = require('async');
import { clearTimeout, setTimeout } from 'timers';

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

	private cmd_delimiter: string = "end_cmd_semaphore";

	private stdout_data: string[] = [];

	private launch_done = new Subject();
	private pending_data = new Subject();

	private sendOutputToClient: boolean = true;
	private largeExpectedOutput: boolean = false;

	private runtime = new EventEmitter();

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
	private breakpoints = new Map<string, IRuntimeBreakpoint[]>();
	private dataBreakpoints = new Array<string>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private breakpointId = 1;

	ls = require("child_process").spawn("/bin/sh", {
		shell: false
	});

	readline = require("readline"); 
	readline_interface = this.readline.createInterface({ 
		input: this.ls.stdout
	});

	constructor() {
		super();

		this.ls.stdout.setEncoding('utf-8');

		this.ls.stdout.on("data", (data: string) => {
			let lines = data.split(/\r?\n/);
			for(var line of lines){
				// This allows us to pinpoint the end of our desired output if it is large enough that it may not appear all in the same listener call
				// TODO: Benchmark the performance cost of having the endcmd flag always on for safety vs the "smart tradeoff" way
				if(this.largeExpectedOutput && line.includes(this.cmd_delimiter)){ 
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

		this.messageQueue.drain(() => {
			console.error('No more lines in the messageQueue');
		})
	}

	messageQueue = async.queue((line: string, completed) => {
		var regExp;
		if(line.search(/\$finish;/) !== -1){
			this.sendSimulatorTerminalCommand("exit");
			setTimeout(() => {
				this.ls.kill();
				this.sendEvent('end');
			}, 250);
		}
		else if(line.search(/Created stop 1:/) !== -1){
			// TODO: Change to be generic to non-UVM testbenches (and/or that don't include END-OF-BUILD stop)
			console.log("DETECTED INITIAL STOP");
			this.sendSimulatorTerminalCommand("run");
			this.stopHit = true;
		}
		else if(regExp = /Created stop (\d+)/.exec(line)){
			let bp_id = parseInt(regExp[1]);
			this.runtime.emit('stopCreated', bp_id);
			console.log(line);
			console.log(`Caught creation of stop ${bp_id}`);
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
			if(!this.stopOnEntry){
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
		return name.split('').map((c, ix) => {
			return {
				id: ix,
				label: `target: ${c}`
			};
		});
	}

	/**
	 * Returns the stack trace
	 */
	public async stack(startFrame: number, endFrame: number): Promise<IRuntimeStack> {
		return this.sendCommandWaitResponse("stack", 5000, true).then((stdout_lines: string[]) => {	
			let names: string[] = [];
			let files: string[] = [];
			let lines: number[] = [];
			while(stdout_lines.length > 0){
				let line = stdout_lines.shift();
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
			var scopes: string[] = [];
			if(names.length) {
				let fullscope: string = names[0].substring(names[0].lastIndexOf(' ') + 1);
				var regExp = /\./g;
				do {
					var m = regExp.exec(fullscope);
					if(m){
						scopes.push(fullscope.substring(0, m.index));
					}
				} while(m);
				scopes.push(fullscope);
			}
			this.scopes = scopes;

			return {
				frames: frames,
				count: names.length
			};
		});
	}

	public getScopes(): string[]{
		return this.scopes;
	}

	/**
	 * Format user condition in a best effort to meet tcl expression requirements, or return undefined
	 */
	private formatConditionToTcl(expression: string): string | undefined{
		// m[0]: match; m[1]: name of the evaluated variable; m[2]: comparison operator, m[3]: numerical condition with optional radix
		const regExp = /^\s*{?\s*#?([a-z_][a-z0-9_\.\[\]]*)\s*(=|==|===|!=|!==|>|>=|<|<=)\s*((\d*'(b|h|d))?[a-f0-9x]*|"[^"]*")\s*}?\s*$/i; 
		var m = regExp.exec(expression);
		if(m){
			// Expression was matched, reconstitute tcl-compliant expression from captured groups
			var lhs = m[1];
			var op = m[2];
			var rhs = m[3];
			const formattedExp = `{#${lhs} ${op} ${rhs}}`;
			return formattedExp;
		}
		else{
			// Expression has unrecoverable errors
			return undefined;
		}
	}

	/**
	 * Set breakpoint in file with given line.
	 */
	public async setBreakPoint(path: string, line: number, hitCountCondition: string | undefined, condition: string | undefined): Promise<IRuntimeBreakpoint> {		
		const bp: IRuntimeBreakpoint = { verified: false, line, id: this.breakpointId++ };
		var wait: NodeJS.Timeout;
		// xrun format
		// Line breakpoint: stop -create -file <filepath> -line <line# (not zero aligned)> -all -name <id>
		var cmd: string = `stop -create -file ${path} -line ${line} -all -name ${bp.id}`;
		if(hitCountCondition){
			cmd += ` -skip ${hitCountCondition}`;
		}
		else if(condition){
			const tcl_expression = this.formatConditionToTcl(condition);
			if(tcl_expression){
				cmd += ` -if ${tcl_expression}`;
			}
			else{
				return bp;
			}
		}
		let bps = this.breakpoints.get(path);
		if (!bps) {
			bps = new Array<IRuntimeBreakpoint>();
			this.breakpoints.set(path, bps);
		}
		bps.push(bp);

		const verified = new Promise<IRuntimeBreakpoint>((resolve, reject) => {
			const cb = ((id: number) => {
				if(bp.id == id){
					bp.verified = true;
					this.runtime.removeListener('stopCreated', cb);
					resolve(bp);
				}
			});
			this.runtime.on('stopCreated', cb);
		});

		const timeout = new Promise<IRuntimeBreakpoint>((resolve, reject) => {
			wait = setTimeout(() => {
				resolve(bp);
			}, 1000);
		});

		this.sendSimulatorTerminalCommand(cmd);

		return Promise.race([
			verified,
			timeout
		]).then(() => {
			clearTimeout(wait);
			return bp;
		});
	}

	public clearBreakpoints(path: string): void {
		const bps = this.breakpoints.get(path);
		if(bps){
			this.sendSimulatorTerminalCommand("stop -delete " + bps.map((bp) => { return bp.id.toString(); }).join(' '));
		}
		this.breakpoints.delete(path);
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
					if(!isNaN(_size)){
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
		// FIXME: xrun returns error, find why
		this.sendSimulatorTerminalCommand('deposit ' + name + ' = #' + value + ' -after 0 -relative');
	}

	public forceOutputFlush(){
		for(var i = 0; i < 1; i++){
			this.sendSimulatorTerminalCommand('puts placeholderplaceholderplaceholderplaceholder123456789', true);
		}
		console.error('Forced output buffer flush');
	}

	// private methods
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
			this.sendSimulatorTerminalCommand(`puts ${this.cmd_delimiter}`, true);
		await this.pending_data.wait(timeout);
		this.sendOutputToClient = true;
		return this.stdout_data;
	}
}
