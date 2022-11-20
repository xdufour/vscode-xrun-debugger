# Changelog

All notable changes to the "vscode-xrun-debugger" will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.1 - 2022-11-20

### Fixed

- Removed typos in README.md

## 0.1.0 - 2022-11-19

### Added 

- Data breakpoints
- Conditional breakpoints
- Variables for SystemVerilog
- Step into
- Step over
- Step out
- Watch
- REPL requests

### Changed

- "env" launch configuration option renamed to "cwd".
- "consoleKeywords" launch configuration option renamed to "problemMatchers".
- "AskForArguments" configuration provider command renamed to "SpecifyArgs".
- Extension now activates on SystemVerilog and Verilog language detection.

### Fixed

- Restart option inproperly terminating the previous host process and therefore not releasing license.
- Stop on breakpoint source files URI now opens even if it wasn't included in the workspace folder(s)

## 0.0.2 - 2022-11-05

### Added 

- Launch
- Breakpoints
- Continue
- Variables for Verilog
- Inline values
- Hover on variables
- QuickPick for launch configuration arguments
- Callstacks
- Debug console