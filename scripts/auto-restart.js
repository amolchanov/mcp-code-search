#!/usr/bin/env node

/**
 * Auto-restart wrapper for debugging crashes
 * Restarts the server automatically when it exits unexpectedly
 */

import { spawn } from 'child_process'
import { appendFileSync, writeFileSync } from 'fs'

const logFile = 'sse-wrapper.log'
const maxRestarts = 10
let restartCount = 0

function log(message) {
	const timestamp = new Date().toISOString()
	const line = `[${timestamp}] ${message}\n`
	console.log(line.trim())
	appendFileSync(logFile, line)
}

function startServer() {
	restartCount++
	log(`\n${'='.repeat(80)}`)
	log(`Starting server (attempt ${restartCount}/${maxRestarts})`)
	log(`${'='.repeat(80)}`)

	const serverProcess = spawn('node', ['--trace-warnings', '--trace-uncaught', 'dist/index.js', '--sse'], {
		stdio: ['inherit', 'pipe', 'pipe'],
		shell: false,
	})

	const startTime = Date.now()

	serverProcess.stdout.on('data', (data) => {
		const output = data.toString()
		process.stdout.write(output)
		appendFileSync(logFile, output)
	})

	serverProcess.stderr.on('data', (data) => {
		const output = data.toString()
		process.stderr.write(output)
		appendFileSync(logFile, output)
	})

	serverProcess.on('exit', (code, signal) => {
		const runtime = ((Date.now() - startTime) / 1000).toFixed(2)
		
		log(`\nServer exited after ${runtime}s`)
		log(`Exit code: ${code}`)
		log(`Signal: ${signal}`)

		if (code === 0 && runtime < 60) {
			log('⚠ Clean exit but suspiciously quick (< 60s)')
		}

		if (signal === 'SIGINT' || signal === 'SIGTERM') {
			log('Manual shutdown detected, exiting wrapper')
			process.exit(0)
		}

		if (restartCount >= maxRestarts) {
			log(`\n❌ Maximum restart attempts (${maxRestarts}) reached. Giving up.`)
			process.exit(1)
		}

		// Wait 5 seconds before restart
		log('Restarting in 5 seconds...')
		setTimeout(startServer, 5000)
	})

	serverProcess.on('error', (error) => {
		log(`\n❌ Failed to start server: ${error.message}`)
		process.exit(1)
	})
}

// Clean log file on start
writeFileSync(logFile, '')
log('Auto-restart wrapper initialized')
log(`Log file: ${logFile}`)
log(`Max restarts: ${maxRestarts}\n`)

startServer()

// Handle shutdown
process.on('SIGINT', () => {
	log('\nReceived SIGINT, shutting down...')
	process.exit(0)
})
