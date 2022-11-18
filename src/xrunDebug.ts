/*
 * xrunDebug.ts implements the Debug Adapter that "adapts" or translates the Debug Adapter Protocol (DAP) used by the client (e.g. VS Code)
 * into requests and events of the real "execution engine" or "debugger" (here: class XrunRuntime).
 * When implementing your own debugger extension for VS Code, most of the work will go into the Debug Adapter.
 * Since the Debug Adapter is independent from VS Code, it can be used in any client (IDE) supporting the Debug Adapter Protocol.
 *
 * The most important class of the Debug Adapter is the XrunDebugSession which implements many DAP requests by talking to the XrunRuntime.
 */

import {
	logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	InvalidatedEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { basename } from 'path-browserify';
import { XrunRuntime, FileAccessor, RuntimeVariable } from './xrunRuntime';
import { Subject } from 'await-notify';
import { LogLevel } from '@vscode/debugadapter/lib/logger';
import async = require('async');

/**
 * This interface describes the xrun-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the xrun-debug extension.
 * The interface should always match this schema.
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** Absolute path to working directory from which the program will be executed. */
	cwd: string;
	/** Absolute path to executable, or relative path if 'cwd' is specified. */
	program: string;
	/** ommand line arguments. Can optionally be a path to a yml file to parse for arguments selection to be displayed, or use \"${command:SpecifyArgs}\" to manually enter them upon launch. */
	args: string;
	/** Lines that match against these keywords in the output console will be sent to stderr. */
	problemMatchers: string[];
	/** Automatically stop after launch. */
	stopOnEntry?: boolean;
	/** Run simulation without debug. */
	noDebug?: boolean;
}

export class XrunDebugSession extends LoggingDebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static threadID = 1;

	private _runtime: XrunRuntime;

	private _variableHandles = new Handles<string>();

	private problemMatchers: string[] = [];

	private _configurationDone = new Subject();

	private _cancellationTokens = new Map<number, boolean>();

	private _valuesInHex = true;
	private _useInvalidatedEvent = false;

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor(fileAccessor: FileAccessor) {
		super("xrun-debug.txt");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		this._runtime = new XrunRuntime();

		// setup event handlers
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', XrunDebugSession.threadID));
		});
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', XrunDebugSession.threadID));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', XrunDebugSession.threadID));
		});
		this._runtime.on('stopOnDataBreakpoint', () => {
			this.sendEvent(new StoppedEvent('data breakpoint', XrunDebugSession.threadID));
		});
		this._runtime.on('stopOnInstructionBreakpoint', () => {
			this.sendEvent(new StoppedEvent('instruction breakpoint', XrunDebugSession.threadID));
		});
		this._runtime.on('stopOnException', (exception) => {
			if (exception) {
				this.sendEvent(new StoppedEvent(`exception(${exception})`, XrunDebugSession.threadID));
			} else {
				this.sendEvent(new StoppedEvent('exception', XrunDebugSession.threadID));
			}
		});
		this._runtime.on('breakpointValidated', (bp_id: number) => {
			this.sendEvent(new BreakpointEvent('changed', { verified: true, id: bp_id } as DebugProtocol.Breakpoint));
		});
		this._runtime.on('output', (type, text: string, filePath, line, column) => {
			let category: string;
			switch(type) {
				case 'prio': category = 'important'; break;
				case 'out': category = 'stdout'; break;
				case 'err': category = 'stderr'; break;
				default: category = 'console'; break;
			}
			this.problemMatchers.forEach((keyword: string) => {
				if(text.search(keyword) !== -1){
					category = 'stderr';
				}
			});
			
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`, category);

			if (text === 'start' || text === 'startCollapsed' || text === 'end') {
				e.body.group = text;
				e.body.output = `group-${text}\n`;
			}

			e.body.source = this.createSource(filePath);
			e.body.line = this.convertDebuggerLineToClient(line);
			e.body.column = this.convertDebuggerColumnToClient(column);
			this.sendEvent(e);
		});
		this._runtime.on('end', () => {
			const e: DebugProtocol.OutputEvent = new OutputEvent('[Xrun-Debug] Simulation ended, terminating xrun host process\n', 'important');
			this.sendEvent(e);
			this.sendEvent(new TerminatedEvent());
		});

		
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		if (args.supportsInvalidatedEvent) {
			this._useInvalidatedEvent = true;
		}

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDone request.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code show a 'step back' button
		response.body.supportsStepBack = false;

		// make VS Code support data breakpoints
		response.body.supportsDataBreakpoints = true;

		response.body.supportsConditionalBreakpoints = true;

		response.body.supportsHitConditionalBreakpoints = true;

		// make VS Code support completion in REPL
		response.body.supportsCompletionsRequest = false;
		response.body.completionTriggerCharacters = [ ".", "[" ];

		// make VS Code send cancel request
		response.body.supportsCancelRequest = true;

		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = false;

		// make VS Code provide "Step in Target" functionality
		response.body.supportsStepInTargetsRequest = true;

		// make VS Code send exceptionInfo request
		response.body.supportsExceptionInfoRequest = false;

		// make VS Code send setVariable request
		response.body.supportsSetVariable = true;

		// make VS Code send setExpression request
		response.body.supportsSetExpression = true;

		// make VS Code send disassemble request
		response.body.supportsDisassembleRequest = true;
		response.body.supportsSteppingGranularity = true;
		response.body.supportsInstructionBreakpoints = true;

		// make VS Code able to read and write variable memory
		response.body.supportsReadMemoryRequest = false;
		response.body.supportsWriteMemoryRequest = false;

		response.body.supportSuspendDebuggee = true;
		response.body.supportTerminateDebuggee = true;
		response.body.supportsFunctionBreakpoints = true;

		this.sendResponse(response);
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
		if(args.terminateDebuggee) {
			const e: DebugProtocol.OutputEvent = new OutputEvent('[Xrun-Debug] Simulation aborted, terminating xrun host process\n', 'important');
			this.sendEvent(e);
			this._runtime.terminate();
		}
		
		console.log(`disconnectRequest suspend: ${args.suspendDebuggee}, terminate: ${args.terminateDebuggee}`);
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		//logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);
		logger.setup(LogLevel.Verbose, false);

		this.problemMatchers = args.problemMatchers;

		// start the program in the runtime
		await this._runtime.start(args.cwd, args.program, args.args, !!args.stopOnEntry, !args.noDebug);

		this.sendEvent(new InitializedEvent());

		// wait 1 second until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		this.sendResponse(response);
	}

	protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments, request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		const path = args.source.path as string;

		// clear all breakpoints for this file
		this._runtime.clearBreakpoints(path);

		// set and verify breakpoint locations
		const actualBreakpoints0 = (args.breakpoints || []).map(async client_bp => {
			return this._runtime.setBreakPoint(path, client_bp.line, client_bp.hitCondition, client_bp.condition).then((runtime_bp) => {
				const bp: DebugProtocol.Breakpoint = new Breakpoint(runtime_bp.verified, runtime_bp.line);
				bp.id = runtime_bp.id;
				return bp;
			});
		});

		const actualBreakpoints = await Promise.all<DebugProtocol.Breakpoint>(actualBreakpoints0);

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(XrunDebugSession.threadID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {

		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		const stk = await this._runtime.stack(startFrame, endFrame);

		response.body = {
			stackFrames: stk.frames.map((f, ix) => {
				const sf: DebugProtocol.StackFrame = new StackFrame(f.index, f.name, this.createSource(f.file), this.convertDebuggerLineToClient(f.line));
				if (typeof f.column === 'number') {
					sf.column = this.convertDebuggerColumnToClient(f.column);
				}

				return sf;
			}),
			// 4 options for 'totalFrames':
			//omit totalFrames property: 	// VS Code has to probe/guess. Should result in a max. of two requests
			totalFrames: stk.count			// stk.count is the correct size, should result in a max. of two requests
			//totalFrames: 1000000 			// not the correct size, should result in a max. of two requests
			//totalFrames: endFrame + 20 	// dynamically increases the size with every requested chunk, results in paging
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		this._variableHandles.reset();
		let scopes_str: string[] = this._runtime.getScopes();
		let scopes: DebugProtocol.Scope[] = [];

		scopes_str.map((s) => {
			scopes.push(new Scope(s, this._variableHandles.create(s), false)); 
		});
		response.body = {
			scopes: scopes
		};
		this.sendResponse(response);
	}

	variablesRequestQueue = async.queue((params: any, completed) => {
		var args: DebugProtocol.VariablesArguments = params.args;
		var response: DebugProtocol.VariablesResponse = params.response;
		const v = this._variableHandles.get(args.variablesReference);
		console.log('Requesting variables for ' + v);
		this._runtime.fetchVariables(v).then((vars :RuntimeVariable[]) => {
			response.body = {
				variables: vars.map(v => this.convertFromRuntime(v))
			};
			console.log('Sending variables response for ' + v);
			this.sendResponse(response);
			completed(null);
		}).catch(() => {
			this.sendResponse(response);
			completed(new Error(`Error requesting variables for + ${v}`));
		});
	}, 1);

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {
		this.variablesRequestQueue.push({args, response}, (error)=>{
			if(error){
				console.error(error.message);
			}
		});
	}

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		/*if (args.variablesReference) {
			const v = this._variableHandles.get(args.variablesReference);
		} else {

		}*/
		const rv = this._runtime.getVariable(args.name);

		const regExp = /\d*?('(d|h|b))[0-9a-f]+/ig;

		if (rv) {
			if(rv.type.search(/^string/) !== -1){
				if(args.value.search(regExp) !== -1){ 
					this._runtime.setVariable(args.name, args.value);
				}
			}
			else {
				this._runtime.setVariable(args.name, args.value);
			}
			response.body = this.convertFromRuntime(rv);
		}

		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this._runtime.continue();
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this._runtime.step();
		this.sendResponse(response);
	}

	protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments) {
		const targets = this._runtime.getStepInTargets(args.frameId);
		response.body = {
			targets: targets.map(t => {
				return { id: t.id, label: t.label };
			})
		};
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this._runtime.stepIn(args.targetId);
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this._runtime.stepOut();
		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {

		let reply: string | undefined;
		let rv: RuntimeVariable | undefined;

		switch (args.context) {
			case 'repl':
			case 'hover':
			case 'variables':
			case 'watch':
				rv = this._runtime.getVariable(args.expression);

				if(!rv)
					rv = await this._runtime.fetchVariable(args.expression);
				break;
		}

		if (rv) {
			const v = this.convertFromRuntime(rv);
			response.body = {
				result: v.value,
				type: v.type,
				variablesReference: v.variablesReference,
				presentationHint: v.presentationHint
			};
		} else {
			response.body = {
				result: reply ? reply : `evaluate(context: '${args.context}', '${args.expression}')`,
				variablesReference: 0
			};
		}

		this.sendResponse(response);
	}

	protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments): void {

		if (args.expression.startsWith('$')) {
			const rv = this._runtime.getVariable(args.expression.substring(1));
			if (rv) {
				rv.value = this.convertToRuntime(args.value);
				response.body = this.convertFromRuntime(rv);
				this.sendResponse(response);
			} else {
				this.sendErrorResponse(response, {
					id: 1002,
					format: `variable '{lexpr}' not found`,
					variables: { lexpr: args.expression },
					showUser: true
				});
			}
		} else {
			this.sendErrorResponse(response, {
				id: 1003,
				format: `'{lexpr}' not an assignable expression`,
				variables: { lexpr: args.expression },
				showUser: true
			});
		}
	}

	protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {

		response.body = {
            dataId: null,
            description: "cannot break on data access",
            accessTypes: undefined,
            canPersist: false
        };

		if (args.variablesReference) {
			const v = this._variableHandles.get(args.variablesReference);
			response.body.dataId = v + '.' + args.name;
		} else {
			response.body.dataId = args.name;
		}
		response.body.description = args.name;
		response.body.accessTypes = [ "write" ]; // read, readWrite
		response.body.canPersist = false;

		this.sendResponse(response);
	}

	protected async setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): Promise<void> {

		// clear all data breakpoints
		this._runtime.clearAllDataBreakpoints();

		response.body = {
			breakpoints: []
		};

		for (const dbp of args.breakpoints) {
			const ok = await this._runtime.setDataBreakpoint(dbp.dataId);
			if(ok){
				response.body.breakpoints.push({
					verified: true
				});
			}
			
		}

		this.sendResponse(response);
	}

	protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): void {

		response.body = {
			targets: [
				{
					label: "item 10",
					sortText: "10"
				},
				{
					label: "item 1",
					sortText: "01",
					detail: "detail 1"
				},
				{
					label: "item 2",
					sortText: "02",
					detail: "detail 2"
				},
				{
					label: "array[]",
					selectionStart: 6,
					sortText: "03"
				},
				{
					label: "func(arg)",
					selectionStart: 5,
					selectionLength: 3,
					sortText: "04"
				}
			]
		};
		this.sendResponse(response);
	}

	protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments) {
		if (args.requestId) {
			this._cancellationTokens.set(args.requestId, true);
		}
	}

	protected customRequest(command: string, response: DebugProtocol.Response, args: any) {
		if (command === 'toggleFormatting') {
			this._valuesInHex = ! this._valuesInHex;
			if (this._useInvalidatedEvent) {
				this.sendEvent(new InvalidatedEvent( ['variables'] ));
			}
			this.sendResponse(response);
		} else {
			super.customRequest(command, response, args);
		}
	}

	//---- helpers

	private convertToRuntime(value: string): string {

		value= value.trim();

		if (value[0] === '\'' || value[0] === '"') {
			return value.substring(1, value.length-2);
		}
		const n = parseFloat(value);
		if (!isNaN(n)) {
			return n.toString();
		}
		return value;
	}

	private convertFromRuntime(v: RuntimeVariable): DebugProtocol.Variable {

		let dapVariable: DebugProtocol.Variable = {
			name: v.name,
			value: v.value,
			type: v.type,
			variablesReference: 0,
			evaluateName: v.name
		};

		if (v.type.search(/\squeue/) !== -1 || v.type.search(/\sstruct/) !== -1) {
			v.reference ??= this._variableHandles.create(v.name);
			dapVariable.variablesReference = v.reference;
		}
		else {
			if(v.type.search(/^int/) !== -1){
				dapVariable.type = 'integer';
			}
			else if(v.type.search(/^string/) !== -1){
				dapVariable.type = 'string';
			}
		}

		return dapVariable;
	}

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), filePath, undefined, undefined, 'xrun-adapter');
	}
}

