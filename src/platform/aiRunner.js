const path = require('path');
const { spawn } = require('child_process');

const SCRIPT_PATH = path.join(__dirname, 'hockey-ai.py');

/**
 * Runs the Python AI script as a child process and resolves its parsed `data`
 * payload. Uses the venv interpreter outside production, where `python3` is on
 * PATH. Rejects on spawn failure, a non-zero exit, an error field in the
 * response, or unparseable stdout.
 * @param {string} message Prompt text passed to the script as argv[1].
 * @returns {Promise<any>}
 */
function runAIPythonScript(message) {
  return new Promise((resolve, reject) => {
    const pythonPath =
      process.env.NODE_ENV === 'production'
        ? 'python3'
        : path.join(__dirname, '../../venv/bin/python3');
    const pythonProcess = spawn(pythonPath, [SCRIPT_PATH, message]);

    let stdout = '';

    pythonProcess.on('error', (error) => {
      console.error('Failed to start python process: ', error);
      reject(`Failed to start python process: ${error.message}`);
    });
    pythonProcess.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    pythonProcess.stderr.on('data', (chunk) => {
      console.error('stderr: ' + chunk);
    });
    pythonProcess.on('close', (code) => {
      console.log('child process exited with code: ' + code);
      if (code !== 0) {
        reject(`Process exited with code ${code}`);
      } else {
        try {
          const scriptResponse = JSON.parse(stdout);
          if (scriptResponse.error) {
            reject(scriptResponse.error);
          } else {
            resolve(scriptResponse.data);
          }
        } catch {
          reject(`Error parsing JSON response\n${stdout}`);
        }
      }
    });
  });
}

module.exports = { runAIPythonScript };
