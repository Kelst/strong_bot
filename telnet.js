import net from 'net';
import fs from 'fs';

function extractPonString(inputString) {
  const pattern = /pon[^>]*/;
  const matches = inputString.match(pattern);
  if (matches) {
    return matches[0].trim().replace(">", "");
  }
  return "";
}
export function getNameOlt(HOST, user, password) {
  return new Promise((resolve, reject) => {
    const tn = new net.Socket();
    let buffer = '';
    let commandIndex = 0;
    const commands = [
      `${user}\n`,
      `${password}\n`,
      "enable\n",
      "show running-config\n",
      "exit\n",
      "exit\n"
    ];
    let oltName = '';
    let exitAttempts = 0;

    tn.connect(23, HOST, () => {
      console.log(`Connected to ${HOST}`);
    });

    tn.on('data', (data) => {
      buffer += data.toString('ascii');
      // console.log('Received:', data.toString());

      if (buffer.includes('Username:') || buffer.includes('Password:') || 
          buffer.includes('#') || buffer.includes('>')) {
        
        if (commandIndex < commands.length) {
          // console.log('Sending:', commands[commandIndex]);
          tn.write(commands[commandIndex]);
          commandIndex++;
        }

        if (buffer.includes('#') && !oltName) {
          oltName = extractPonString(buffer);
          console.log('Extracted OLT name:', oltName);
        }

        if (buffer.includes('>') && exitAttempts < 2) {
          console.log('Sending additional exit command');
          tn.write("exit\n");
          exitAttempts++;
        }

        if (exitAttempts === 2) {
          tn.destroy();
          resolve(oltName);
        }
      }
    });

    tn.on('error', (error) => {
      console.error('Connection error:', error);
      reject(error);
    });

    tn.on('close', () => {
      console.log('Connection closed');
      if (!oltName) {
        reject(new Error('Connection closed without retrieving OLT name'));
      }
    });

    setTimeout(() => {
      tn.destroy();
      reject(new Error('Connection timeout'));
    }, 30000);
  });
}
export function getTelnetConfig(HOST, user, password, sfp, maxSfp) {
  return new Promise((resolve, reject) => {
    const tn = new net.Socket();
    let buffer = '';
    let commandIndex = 0;
    const commands = [
      `${user}\n`,
      `${password}\n`,
      "enable\n",
      `show running-config | begin epon0/${sfp}\n`
    ];
    let config = '';
    let configStarted = false;
    let lastSfpFound = false;
    let timeoutId;

    tn.connect(23, HOST, () => {
      console.log(`Connected to ${HOST}`);
      sendNextCommand();
    });

    function sendNextCommand() {
      if (commandIndex < commands.length) {
        tn.write(commands[commandIndex]);
        commandIndex++;
      }
    }

    function processBuffer() {
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.includes(`interface EPON0/${sfp}`)) {
          configStarted = true;
        }
        if (configStarted) {
          if (line.match(/interface EPON0\/(\d+)/) && !line.includes(`interface EPON0/${sfp}`)) {
            const currentSfp = parseInt(line.match(/interface EPON0\/(\d+)/)[1]);
            if (currentSfp > sfp) {
              lastSfpFound = true;
              break;
            }
          }
          if (sfp == maxSfp && (line.includes('#') || line.includes('>'))) {
            lastSfpFound = true;
            break;
          }
          if (line.trim() !== '' && !line.includes('--More--') && !line.includes('Building configuration...')) {
            config += line + '\n';
          }
        }
      }
      buffer = '';

      if (lastSfpFound) {
        finishCollection();
      }
    }

    function finishCollection() {
      clearTimeout(timeoutId);
      tn.destroy();
      resolve(config.trim());
    }

    tn.on('data', (data) => {
      buffer += data.toString('ascii');

      if (buffer.includes('Username:') || buffer.includes('Password:') || 
          buffer.includes('#') || buffer.includes('>')) {
        sendNextCommand();
      }

      if (buffer.includes('--More--') || buffer.includes(' --More-- ')) {
        tn.write(' ');
        buffer = buffer.replace(/--More--|-+\s+\(q\) quit\s+\([^)]+\)\s+\([^)]+\)\s+\([^)]+\)/, '');
      }

      processBuffer();
    });

    tn.on('error', (error) => {
      console.error('Connection error:', error);
      clearTimeout(timeoutId);
      reject(error);
    });

    tn.on('close', () => {
      console.log('Connection closed');
      if (!config) {
        reject(new Error('Connection closed without retrieving config'));
      } else {
        resolve(config.trim());
      }
    });

    timeoutId = setTimeout(() => {
      tn.destroy();
      if (!config) {
        reject(new Error('Connection timeout'));
      } else {
        resolve(config.trim());
      }
    }, 120000); // 120 секунд таймаут
  });
}
export function checkOnuStatus(HOST, user, password, onuMacs) {
  return new Promise((resolve, reject) => {
    const tn = new net.Socket();
    let buffer = '';
    let commandIndex = 0;
    const commands = [
      `${user}\n`,
      `${password}\n`,
      "enable\n",
      ...onuMacs.map(mac => `show epon onu-information mac-address ${mac}\n`),
      "exit\n"
    ];
    console.log(commands, "commandsvcommandscommandscommandscommandscommands");
    let onuStatuses = [];

    tn.connect(23, HOST, () => {
      console.log(`Connected to ${HOST}`);
    });

    function sendNextCommand() {
      if (commandIndex < commands.length) {
        setTimeout(() => {
          const command = commands[commandIndex];
          if (command !== undefined) {
            tn.write(command);
            commandIndex++;
          } else {
            console.error(`Undefined command at index ${commandIndex}`);
            commandIndex++; // Skip this command and move to the next
          }
        }, 1000); // 1 секунда затримки
      } else {
        processBuffer();
        if (onuStatuses.length === onuMacs.length) {
          tn.destroy();
          resolve(onuStatuses);
        }
      }
    }

    tn.on('data', (data) => {
      buffer += data.toString('ascii');

      if (buffer.includes('Username:') || buffer.includes('Password:') || 
          buffer.includes('#') || buffer.includes('>')) {
        sendNextCommand();
      }

      if (buffer.includes('--More--') || buffer.includes(' --More-- ')) {
        setTimeout(() => {
          tn.write(' ');
        }, 1000); // 1 секунда затримки перед відправкою пробілу
        buffer = buffer.replace(/--More--|-+\s+\(q\) quit\s+\([^)]+\)\s+\([^)]+\)\s+\([^)]+\)/, '');
      }
    });

    function processBuffer() {
      const lines = buffer.split('\n');
      let currentMac = '';
      let onuInfo = {};

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        if (line.includes('show epon onu-information mac-address')) {
          if (Object.keys(onuInfo).length > 0) {
            onuStatuses.push(onuInfo);
            onuInfo = {};
          }
          currentMac = line.split(' ').pop().trim();
          onuInfo = { mac: currentMac };
        }
        
        if (line.startsWith('EPON0/') && line.toLowerCase().includes(currentMac.toLowerCase())) {
          const parts = line.split(/\s+/).filter(part => part.trim() !== '');
          if (parts.length >= 5) {
            onuInfo.interface = parts[0];
            onuInfo.type = parts[1];
            onuInfo.model = parts[2];
          }
          
          if (i + 1 < lines.length) {
            const nextLine = lines[i + 1].trim();
            const statusParts = nextLine.split(/\s+/).filter(part => part.trim() !== '');
            if (statusParts.length >= 3) {
              onuInfo.status = statusParts[statusParts.length - 1];
              onuInfo.deregReason = statusParts[statusParts.length - 2] !== 'static' ? statusParts[statusParts.length - 2] : undefined;
            }
          }
        }
      }
      
      if (Object.keys(onuInfo).length > 0) {
        onuStatuses.push(onuInfo);
      }
      
      buffer = '';
    }

    tn.on('error', (error) => {
      console.error('Connection error:', error);
      reject(error);
    });

    tn.on('close', () => {
      console.log('Connection closed');
      if (onuStatuses.length === 0) {
        reject(new Error('Connection closed without retrieving ONU statuses'));
      } else {
        resolve(onuStatuses);
      }
    });

    setTimeout(() => {
      tn.destroy();
      if (onuStatuses.length === 0) {
        reject(new Error('Connection timeout'));
      } else {
        resolve(onuStatuses);
      }
    }, 60000); // 60 секунд таймаут
  });
}
export function getOnuPowerLevels(activeONUs, HOST, user, password, progressCallback) {
  return new Promise((resolve, reject) => {
    const tn = new net.Socket();
    let buffer = '';
    let commandIndex = 0;
    const results = [];
    const totalONUs = activeONUs.length;
    let processedONUs = 0;

    const commands = [
      `${user}\n`,
      `${password}\n`,
      'enable\n',
      ...activeONUs.map(onu => `show epon interface ${onu.interface} onu ctc optical-transceiver-diagnosis\n`)
    ];

    function sendNextCommand() {
      if (commandIndex < commands.length) {
        console.log(`Sending command: ${commands[commandIndex].trim()}`);
        tn.write(commands[commandIndex]);
        commandIndex++;
        if (progressCallback) {
          progressCallback(commandIndex, commands.length);
        }
      } else {
        finishExecution();
      }
    }

    function processBuffer() {
      console.log('Processing buffer:', buffer);
      if (buffer.includes('received power(DBm):')) {
        const match = buffer.match(/received power\(DBm\):\s*([-\d.]+)/);
        if (match) {
          results.push({
            interface: activeONUs[processedONUs].interface,
            receivedPower: parseFloat(match[1])
          });
          processedONUs++;
        }
      }
      buffer = '';
    }

    function finishExecution() {
      tn.destroy();
      resolve(results);
    }

    tn.connect(23, HOST, () => {
      console.log(`Connected to ${HOST}`);
    });

    tn.on('data', (data) => {
      buffer += data.toString('ascii');
      console.log('Received:', buffer);

      if (buffer.includes('Username:') || buffer.includes('Password:') || 
          buffer.includes('#') || buffer.includes('>')) {
        sendNextCommand();
        processBuffer();
      }
    });

    tn.on('error', (error) => {
      console.error('Connection error:', error);
      reject(error);
    });

    tn.on('close', () => {
      console.log('Connection closed');
      if (results.length === 0) {
        reject(new Error('Connection closed without retrieving power levels'));
      } else {
        resolve(results);
      }
    });

    // Встановлюємо загальний таймаут
    setTimeout(() => {
      if (processedONUs < totalONUs) {
        console.log(`Timeout reached. Processed ${processedONUs} out of ${totalONUs} ONUs.`);
        finishExecution();
      }
    }, 60000); // 60 секунд таймаут
  });
}
export function cleanupSfp(HOST, user, password, cleanupConfigFile) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(cleanupConfigFile) || fs.readFileSync(cleanupConfigFile, 'utf8').trim() === '') {
      resolve('Файл конфігурації для очистки порожній або не існує.');
      return;
    }

    const tn = new net.Socket();
    const commands = fs.readFileSync(cleanupConfigFile, 'utf8').split('\n');
    let commandIndex = 0;
    let buffer = '';

    tn.connect(23, HOST, () => {
      console.log(`Connected to ${HOST}`);
    });

    tn.on('data', (data) => {
      buffer += data.toString('ascii');

      if (buffer.includes('Username:') || buffer.includes('Password:') || 
          buffer.includes('#') || buffer.includes('>')) {
        
        if (buffer.includes('Username:')) {
          tn.write(`${user}\n`);
        } else if (buffer.includes('Password:')) {
          tn.write(`${password}\n`);
        } else if (commandIndex < commands.length) {
          tn.write(`${commands[commandIndex]}\n`);
          commandIndex++;
        } else {
          tn.destroy();
          resolve('Очищення SFP успішно завершено.');
        }

        buffer = '';
      }
    });

    tn.on('error', (error) => {
      console.error('Connection error:', error);
      reject(`Помилка з'єднання: ${error.message}`);
    });

    tn.on('close', () => {
      console.log('Connection closed');
      if (commandIndex < commands.length) {
        reject(`З'єднання закрито до завершення всіх команд.`);
      }
    });

    setTimeout(() => {
      tn.destroy();
      reject(`Час очікування з'єднання вичерпано.`);
    }, 60000); // 60 секунд таймаут
  });
}
export function configureDestinationOlt(HOST, user, password, configFile) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(configFile) || fs.readFileSync(configFile, 'utf8').trim() === '') {
      resolve('Файл конфігурації для destination OLT порожній або не існує.');
      return;
    }

    const tn = new net.Socket();
    const commands = fs.readFileSync(configFile, 'utf8').split('\n');
    let commandIndex = 0;
    let buffer = '';
    const unavailableONUs = [];
    let currentInterface = '';

    tn.connect(23, HOST, () => {
      console.log(`Connected to ${HOST}`);
    });

    tn.on('data', (data) => {
      buffer += data.toString('ascii');

      if (buffer.includes('Username:')) {
        tn.write(`${user}\n`);
        buffer = '';
      } else if (buffer.includes('Password:')) {
        tn.write(`${password}\n`);
        buffer = '';
      } else if (buffer.includes('Are you sure to use absent-config-mode(y/n)?')) {
        tn.write('y\n');
        unavailableONUs.push(currentInterface);
        buffer = '';
      } else if (buffer.includes('#') || buffer.includes('>')) {
        if (commandIndex < commands.length) {
          const command = commands[commandIndex].trim();
          if (command.startsWith('interface')) {
            currentInterface = command.split(' ')[2];
          }
          tn.write(`${command}\n`);
          commandIndex++;
        } else {
          tn.destroy();
          resolve({
            message: 'Налаштування destination OLT успішно завершено.',
            unavailableONUs: unavailableONUs
          });
        }
        buffer = '';
      }
    });

    tn.on('error', (error) => {
      console.error('Connection error:', error);
      reject(`Помилка з'єднання: ${error.message}`);
    });

    tn.on('close', () => {
      console.log('Connection closed');
      if (commandIndex < commands.length) {
        reject(`З'єднання закрито до завершення всіх команд.`);
      }
    });

    setTimeout(() => {
      tn.destroy();
      reject(`Час очікування з'єднання вичерпано.`);
    }, 300000); // Збільшуємо таймаут до 5 хвилин (300000 мс)
  });
}
// export function configureDestinationOlt(HOST, user, password, configFile) {
//   return new Promise((resolve, reject) => {
//     if (!fs.existsSync(configFile) || fs.readFileSync(configFile, 'utf8').trim() === '') {
//       resolve('Файл конфігурації для destination OLT порожній або не існує.');
//       return;
//     }

//     const tn = new net.Socket();
//     const commands = fs.readFileSync(configFile, 'utf8').split('\n');
//     let commandIndex = 0;
//     let buffer = '';
//     const unavailableONUs = [];
//     let currentInterface = '';
//     const missingVlans = new Set();
//     const vlansNotOnSfp = new Set();
//     let currentVlan = '';
//     let lastActivityTime = Date.now();
//     let isWaitingForMore = false;
//     let lastCommand = '';
//     let vlanCheckComplete = false;
//     let isInEnableMode = false;

//     tn.connect(23, HOST, () => {
//       console.log(`Connected to ${HOST}`);
//       lastActivityTime = Date.now();
//     });

//     function sendNextCommand() {
//       if (commandIndex < commands.length) {
//         const command = commands[commandIndex].trim();
//         if (command !== lastCommand) {
//           console.log(`Sending command: ${command}`);
//           if (command.startsWith('interface') && isInEnableMode) {
//             tn.write("exit\n");
//             isInEnableMode = false;
//           }
//           tn.write(`${command}\n`);
//           lastCommand = command;
//           commandIndex++;
//           lastActivityTime = Date.now();
//         } else {
//           console.log(`Skipping duplicate command: ${command}`);
//           commandIndex++;
//           sendNextCommand();
//         }
//       } else {
//         console.log('All commands sent');
//         processBuffer();
//         tn.destroy();
//         const message = 'Налаштування destination OLT успішно завершено.';
//         const missingVlansMessage = missingVlans.size > 0 ? 
//           `Відсутні VLAN на OLT: ${Array.from(missingVlans).join(', ')}` : '';
//         const vlansNotOnSfpMessage = vlansNotOnSfp.size > 0 ? 
//           `VLAN відсутні на SFP: ${Array.from(vlansNotOnSfp).join(', ')}` : '';
//         resolve({
//           message,
//           unavailableONUs,
//           missingVlansMessage,
//           vlansNotOnSfpMessage
//         });
//       }
//     }

//     function processBuffer() {
//       console.log('Processing buffer:', buffer);
//       if (buffer.includes('VLAN') && buffer.includes('not found in current VLAN database')) {
//         const vlanMatch = buffer.match(/VLAN (\d+) not found/);
//         if (vlanMatch) {
//           missingVlans.add(vlanMatch[1]);
//         }
//         vlanCheckComplete = true;
//       } else if (buffer.includes('VLAN id:')) {
//         vlanCheckComplete = true;
//       }
      
//       if (buffer.includes('switchport trunk vlan-allowed') || 
//           buffer.includes('switchport dot1q-translating-tunnel mode flat translate')) {
//         const lines = buffer.split('\n');
//         const vlanLine = lines.find(line => line.includes('switchport trunk vlan-allowed'));
//         const translateLine = lines.find(line => line.includes('switchport dot1q-translating-tunnel mode flat translate'));
        
//         if (vlanLine) {
//           const vlans = vlanLine.match(/\d+/g);
//           if (vlans && !vlans.includes(currentVlan)) {
//             vlansNotOnSfp.add(currentVlan);
//           }
//         }
//         if (translateLine) {
//           const vlans = translateLine.match(/\d+/g);
//           if (vlans && !vlans.includes(currentVlan)) {
//             vlansNotOnSfp.add(currentVlan);
//           }
//         }
//         if (!vlanLine && !translateLine) {
//           vlansNotOnSfp.add(currentVlan);
//         }
//       }
//       buffer = '';
//     }

//     tn.on('data', (data) => {
//       buffer += data.toString('ascii');
//       console.log('Received data:', data.toString());
//       lastActivityTime = Date.now();

//       if (buffer.includes('Username:')) {
//         tn.write(`${user}\n`);
//         buffer = '';
//       } else if (buffer.includes('Password:')) {
//         tn.write(`${password}\n`);
//         buffer = '';
//       } else if (buffer.includes('Are you sure to use absent-config-mode(y/n)?')) {
//         tn.write('y\n');
//         unavailableONUs.push(currentInterface);
//         buffer = '';
//       } else if (buffer.includes('#')) {
//         if (isWaitingForMore) {
//           tn.write(' ');
//           isWaitingForMore = false;
//         } else if (vlanCheckComplete) {
//           vlanCheckComplete = false;
//           sendNextCommand();
//         } else if (commandIndex < commands.length) {
//           const command = commands[commandIndex].trim();
//           if (command.startsWith('interface')) {
//             currentInterface = command.split(' ')[2];
//             sendNextCommand();
//           } else if (command.includes('epon onu port 1 ctc vlan mode tag')) {
//             const vlan = command.split(' ').pop();
//             if (!isInEnableMode) {
//               tn.write("exit\n");
//               tn.write("enable\n");
//               isInEnableMode = true;
//             }
//             tn.write(`show vlan id ${vlan}\n`);
//             currentVlan = vlan;
//           } else if (command === 'exit' && commandIndex === commands.length - 2) {
//             const sfp = currentInterface.split('/')[1].split(':')[0];
//             if (!isInEnableMode) {
//               tn.write("enable\n");
//               isInEnableMode = true;
//             }
//             tn.write(`show running-config interface ePON 0/${sfp}\n`);
//           } else {
//             sendNextCommand();
//           }
//         } else {
//           processBuffer();
//           tn.destroy();
//         }
//       } else if (buffer.includes('--More--') || buffer.includes(' --More-- ')) {
//         isWaitingForMore = true;
//         tn.write(' ');
//       } else if (buffer.includes('Unknown command')) {
//         console.log('Unknown command detected, moving to next command');
//         vlanCheckComplete = true;
//         sendNextCommand();
//       }
//     });

//     tn.on('error', (error) => {
//       console.error('Connection error:', error);
//       reject(`Помилка з'єднання: ${error.message}`);
//     });

//     tn.on('close', () => {
//       console.log('Connection closed');
//       if (commandIndex < commands.length) {
//         reject(`З'єднання закрито до завершення всіх команд.`);
//       }
//     });

//     // Перевірка активності кожні 5 секунд
//     const activityCheck = setInterval(() => {
//       const currentTime = Date.now();
//       if (currentTime - lastActivityTime > 10000) { // 10 секунд без активності
//         console.log('No activity for 10 seconds, sending next command');
//         sendNextCommand();
//       }
//     }, 5000);

//     setTimeout(() => {
//       clearInterval(activityCheck);
//       tn.destroy();
//       reject(`Час очікування з'єднання вичерпано.`);
//     }, 300000); // 5 хвилин таймаут
//   });
// }

export function configureOpensvitVlan(ip, telnetLogin, telnetPass, pvid, OPENSVIT, sfp) {
  return new Promise((resolve, reject) => {
    const tn = new net.Socket();
    let buffer = '';
    let commandIndex = 0;
    const commands = [
      `${telnetLogin}\n`,
      `${telnetPass}\n`,
      "enable\n",
      `show running-config interface ePON 0/${sfp}\n`
    ];
    let waitingForConfig = false;
    let configBuffer = '';

    tn.connect(23, ip, () => {
      console.log(`Connected to ${ip}`);
      sendNextCommand();
    });

    tn.on('data', (data) => {
      buffer += data.toString('ascii');
      console.log('Received:', buffer);

      if (buffer.includes('Username:') || buffer.includes('Password:')) {
        sendNextCommand();
        buffer = '';
      } else if (buffer.includes('#') || buffer.includes('>')) {
        if (waitingForConfig) {
          configBuffer += buffer;
          if (buffer.trim().endsWith('#')) {
            console.log("Configuration received. Processing...");
            processConfig(configBuffer);
            waitingForConfig = false;
          }
        } else {
          sendNextCommand();
        }
        buffer = '';
      }

      if (buffer.includes('--More--') || buffer.includes(' --More-- ')) {
        tn.write(' ');
        buffer = buffer.replace(/--More--|-+\s+\(q\) quit\s+\([^)]+\)\s+\([^)]+\)\s+\([^)]+\)/, '');
      }
    });

    function sendNextCommand() {
      if (commandIndex < commands.length) {
        const command = commands[commandIndex];
        console.log(`Sending command: ${command.trim()}`);
        tn.write(command);
        commandIndex++;
        if (command.includes('show running-config')) {
          waitingForConfig = true;
          configBuffer = '';
        }
      } else {
        tn.destroy();
        resolve("Configuration completed successfully");
      }
    }

    function processConfig(config) {
      console.log("Processing configuration...");
      const configLines = config.split('\n');
      const hasDotTranslating = configLines.some(line => 
        line.includes(`switchport dot1q-translating-tunnel mode flat translate 1to1 ${OPENSVIT} ${OPENSVIT} 0`));
      const trunkLine = configLines.find(line => line.includes('switchport trunk vlan-allowed'));

      const additionalCommands = [];

      if (!hasDotTranslating) {
        additionalCommands.push(`switchport dot1q-translating-tunnel mode flat translate 1to1 ${OPENSVIT} ${OPENSVIT} 0`);
      }

      if (trunkLine) {
        if (!trunkLine.includes(OPENSVIT.toString())) {
          additionalCommands.push(`switchport trunk vlan-allowed add ${OPENSVIT}`);
        }
      } else {
        additionalCommands.push(`switchport trunk vlan-allowed ${OPENSVIT},${pvid}`);
      }

      if (additionalCommands.length > 0) {
        console.log("Additional commands needed:", additionalCommands);
        commands.push("config\n");
        commands.push(`interface epon0/${sfp}\n`);
        commands.push(...additionalCommands.map(cmd => cmd + '\n'));
        commands.push("exit\n");
        commands.push("exit\n");
        commands.push("write\n");
      } else {
        console.log("No changes needed. Configuration is up to date.");
      }
      sendNextCommand();
    }

    tn.on('error', (error) => {
      console.error('Connection error:', error);
      reject(error);
    });

    tn.on('close', () => {
      console.log('Connection closed');
      if (waitingForConfig) {
        reject(new Error('Connection closed unexpectedly while waiting for configuration'));
      }
    });

    setTimeout(() => {
      tn.destroy();
      reject(new Error('Connection timeout'));
    }, 180000); // 180 секунд загальний таймаут
  });
}