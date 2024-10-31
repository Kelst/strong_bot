import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { promisify } from 'util';
import ping from 'ping';
import { takeMacVlans,takeMacAddresses, takeMacAddressesP, queryDatabaseBilling } from './api.js';
import { exec } from 'child_process';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
 
const readFile = promisify(fs.readFile);

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}





export class OltData {
    constructor() {
      this.ip = '';
      this.sfp = 0;
      this.ID = 0;
      this.PPOE = 0;
      this.OPENSVIT = 0;
      this.maxSfp = 0;
      this.telnetLogin = '';
      this.telnetPass = '';
      this.name = '';
      this.pvid = 0;
    }
  
    reset() {
      this.ip = '';
      this.PPOE = 0;
      this.sfp = 0;
      this.maxSfp = 0;
      this.ID = 0;
      this.telnetLogin = '';
      this.telnetPass = '';
      this.name = '';
      this.pvid = 0;

    }
}
export function userHasArchive(userId) {
  const fileName = `${userId}.zip`;
  const filePath = path.join(uploadsDir, fileName);
  return fs.existsSync(filePath);
}
export function showMenu(bot, chatId, showRestartButton = false, showProcessButton = false, hideTransferButton = false, showCheckStatusButton = false, mode = 'main') {
  if (mode === 'main') {
    const keyboard=[]
  if (showProcessButton) {
    keyboard.push(['Опрацювати']);
  } else if (!hideTransferButton) {
    keyboard.push(['Перенести конфіг']);
  }
  if (showCheckStatusButton) {
    keyboard.push(['Перевірити статус ONU']);
  }
  if (showRestartButton) {
    keyboard.push(['Почати з початку']);
  }
  
  const opts = {
    reply_markup: JSON.stringify({
      keyboard: keyboard,
      resize_keyboard: true,
      one_time_keyboard: false
    })
  };
  bot.sendMessage(chatId, '->|', opts);
}else if (mode === 'additional') {
  const keyboard = [
    ['Згенерувати темплейти для SFP'],
    ['Прописати PPPoE VLAN'],
    ['Прописати IPoE VLAN'],
    ['Прописати Opensvit VLAN'],
    ['Повернутися до головного меню']
  ];
  
  const opts = {
    reply_markup: JSON.stringify({
      keyboard: keyboard,
      resize_keyboard: true,
      one_time_keyboard: false
    })
  };
  bot.sendMessage(chatId, 'Виберіть додаткову опцію:', opts);
}
}
export async function saveFile(downloadUrl, userId) {
  const fileName = `${userId}.zip`;
  const filePath = path.join(uploadsDir, fileName);

  const response = await fetch(downloadUrl);
  if (!response.ok) throw new Error('Не вдалося завантажити файл');
  
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(filePath, Buffer.from(arrayBuffer));

  return fileName;
}
export function isValidIp(ip) {
  const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  return ipPattern.test(ip) && ip.split('.').every(part => parseInt(part) >= 0 && parseInt(part) <= 255);
}
export function isValidSfp(sfp, maxSfp) {
  const sfpNumber = parseInt(sfp);
  return !isNaN(sfpNumber) && sfpNumber >= 1 && sfpNumber <= maxSfp;
}
export async function processArchive(userId, sourceOlt, config = null) {
  let runningConfig = config;
  let diagnosticInfo = '';

  if (!runningConfig) {
    const archivePath = path.join(uploadsDir, `${userId}.zip`);
    const zip = new AdmZip(archivePath);
    const zipEntries = zip.getEntries();

    diagnosticInfo += `Шукаємо конфігурацію для OLT: ${sourceOlt.name}\n`;
    // diagnosticInfo += `Кількість файлів в архіві: ${zipEntries.length}\n`;

    let oltFolder = null;
    for (const entry of zipEntries) {
      const folderName = path.basename(path.dirname(entry.entryName));
      if (folderName === sourceOlt.name) {
        oltFolder = folderName;
        // diagnosticInfo += `Знайдено папку OLT: ${folderName}\n`;
        break;
      }
    }

    if (!oltFolder) {
      diagnosticInfo += `Не знайдено папку для OLT ${sourceOlt.name}\n`;
      return { onuConfigs: [], runningConfig: null, diagnosticInfo };
    }

    for (const entry of zipEntries) {
      if (entry.entryName.includes(`${oltFolder}/`) && entry.name === 'running-config.conf') {
        runningConfig = entry.getData().toString('utf8');
        // diagnosticInfo += `Знайдено файл конфігурації: ${entry.entryName}\n`;
        break;
      }
    }

    if (!runningConfig) {
      diagnosticInfo += `Не знайдено файл running-config.conf для OLT ${sourceOlt.name}\n`;
      return { onuConfigs: [], runningConfig: null, diagnosticInfo };
    }
  } else {
    diagnosticInfo += `Використовуємо конфігурацію, отриману через Telnet\n`;
  }

  // Попередня обробка конфігурації
  runningConfig = runningConfig.replace(/\r\n/g, '\n');
  runningConfig = runningConfig.replace(/\x08+/g, '');

  const onuConfigs = [];
  const lines = runningConfig.split('\n');
  const macBindings = {};
  const vlanConfigs = {};
  let currentInterface = null;
  let currentSfp = null;
  let pvid = null;
  let onuBindings = [];
  let globalPvid = null;

  for (const line of lines) {
    const trimmedLine = line.trim();
    
    if (trimmedLine.startsWith('interface EPON0/')) {
      const sfpMatch = trimmedLine.match(/interface EPON0\/(\d+)(:(\d+))?/);
      if (sfpMatch) {
        currentSfp = parseInt(sfpMatch[1]);
        if (sfpMatch[3]) {
          currentInterface = `${currentSfp}:${sfpMatch[3]}`;
        } else {
          currentInterface = null;
        }
      }
      pvid = null; // Reset PVID for new interface
    } else if (trimmedLine.startsWith('epon bind-onu mac')) {
      const match = trimmedLine.match(/epon bind-onu mac ([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}) (\d+)/);
      if (match && currentSfp !== null) {
        const [, mac, onuNumber] = match;
        macBindings[`${currentSfp}:${onuNumber}`] = mac;
        onuBindings.push({ mac, sfp: currentSfp, onuNumber: parseInt(onuNumber) });
      }
    } else if (currentInterface) {
      // Покращений пошук VLAN'ів
      const vlanPatterns = [
        /epon onu port \d+ (ctc vlan mode tag|vlan mode tag|vlan) ([\d\s,]+)/,
        /switchport mode trunk vlan ([\d\s,]+)/,
        /switchport vlan ([\d\s,]+) tag/
      ];
      
      for (const pattern of vlanPatterns) {
        const match = trimmedLine.match(pattern);
        if (match) {
          const vlanString = match[match.length - 1];
          const vlans = vlanString.split(/[\s,]+/).map(v => parseInt(v)).filter(v => !isNaN(v));
          
          if (!vlanConfigs[currentInterface]) {
            vlanConfigs[currentInterface] = [];
          }
          
          vlans.forEach(vlan => {
            if (!vlanConfigs[currentInterface].includes(vlan)) {
              vlanConfigs[currentInterface].push(vlan);
            }
          });
        }
      }
    } else if (trimmedLine.startsWith('switchport pvid')) {
      const pvidMatch = trimmedLine.match(/switchport pvid (\d+)/);
      if (pvidMatch) {
        pvid = parseInt(pvidMatch[1]);
        if (currentSfp !== null && currentSfp === sourceOlt.sfp) {
          globalPvid = pvid;
        }
      }
    }
  }

  for (const [key, mac] of Object.entries(macBindings)) {
    const [sfp, onuNumber] = key.split(':');
    const interfaceName = `EPON0/${sfp}:${onuNumber}`;
    const vlans = vlanConfigs[`${sfp}:${onuNumber}`] || [];
    
    if (parseInt(sfp) === sourceOlt.sfp) {
      onuConfigs.push({
        mac,
        interface: interfaceName,
        vlans,
        isMultiport: vlans.length > 1,
        pvid: globalPvid
      });
    }
  }

  diagnosticInfo += `Знайдено ${onuConfigs.length} конфігурацій ONU для SFP ${sourceOlt.sfp}\n`;
  diagnosticInfo += `PVID для SFP ${sourceOlt.sfp}: ${globalPvid}\n`;
  // console.log(onuConfigs, "onuConfigs");

  return { onuConfigs, runningConfig, diagnosticInfo, onuBindings, pvid: globalPvid };
}
export async function pingHost(host) {
  try {
    const result = await ping.promise.probe(host, {
      timeout: 10,
      extra: ['-c', '3'],
    });
    return result.alive;
  } catch (error) {
    console.error(`Error pinging host ${host}:`, error);
    return false;
  }
}
export function processMigratedONUs(sourceResult, destinationResult) {
  const migratedONUs = [];

  sourceResult.onuConfigs.forEach(sourceONU => {
    const destinationONU = destinationResult.onuConfigs.find(dstONU => dstONU.mac == sourceONU.mac);
    if (destinationONU) {
      migratedONUs.push({
        mac: sourceONU.mac,
        oldInterface: sourceONU.interface,
        newInterface: destinationONU.interface,
        oldVlans: sourceONU.vlans
      });
    }
  });

  return migratedONUs;
}
export function generateCleanupConfig(migratedONUs, sourceOlt, userId) {
  if (migratedONUs.length === 0) {
    console.log("No migrated ONUs to process.");
    return null;
  }
  const sourceConfig =[]
  sourceConfig.push('enable');
  sourceConfig.push('config');
  sourceConfig.push(`interface EPON 0/${sourceOlt.sfp}`);


  migratedONUs.forEach(onu => {
    const [, sourceOnuNumber] = onu.oldInterface.split(':');
    sourceConfig.push(`no epon bind-onu sequence ${sourceOnuNumber}`);
  });

  sourceConfig.push('exit');
  sourceConfig.push('exit');

  // Write configuration to file
  const sourceFileName = `source_olt_cleanup_${userId}.txt`;
  const filePath = path.resolve(sourceFileName);

  fs.writeFileSync(filePath, sourceConfig.join('\n'));

  return filePath;
}
export function generateMigrationConfig(migratedONUs, sourceOlt, destinationOlt, userId) {
  const config = [];
  config.push("enable")
  config.push("config")
  const ipoeONUs = [];
  const pppoeONUs = [];  // Новий масив для PPPoE ONU
  const specialCasesONUs = [];
  const unconfiguredONUs = [];
  let opensvitCount = 0;
  let pvidCount = 0;
  let pppoeCount = 0;
  let unconfiguredCount = 0;

  const isSpecialCase = (vlan, oldInterface) => {
    const [, sfp, onuNumber] = oldInterface.match(/EPON0\/(\d+):(\d+)/);
    const onuNum = parseInt(onuNumber);
    let expectedVlan;
    
    if (onuNum >= 1 && onuNum <= 9) {
      expectedVlan = parseInt(`${sfp}0${onuNum}`);
    } else if (onuNum >= 10 && onuNum <= 64) {
      expectedVlan = parseInt(`${sfp}${onuNum}`);
    } else {
      return true;
    }
    
    return vlan !== expectedVlan;
  };

  migratedONUs.forEach(onu => {
    const [, destSfp, destOnuNumber] = onu.newInterface.match(/EPON0\/(\d+):(\d+)/);
    const destInterface = `interface EPON0/${destSfp}:${destOnuNumber}`;
    const oldVlan = onu.oldVlans && onu.oldVlans.length > 0 ? onu.oldVlans[0] : null;

    if (!oldVlan) {
      unconfiguredONUs.push(onu);
      unconfiguredCount++;
    } else if (oldVlan == sourceOlt.pvid && !sourceOlt.PPOE) {
      config.push(destInterface);
      if (destinationOlt.PPOE) {
        config.push(`epon onu port 1 ctc vlan mode tag ${destinationOlt.PPOE}`);
      } else {
        config.push('no epon onu port 1 ctc vlan mode');
      }
      pppoeONUs.push(onu);  // Додаємо ONU до масиву PPPoE
      pppoeCount++;
    } else if (oldVlan == sourceOlt.PPOE) {
      config.push(destInterface);
      if (destinationOlt.PPOE) {
        config.push(`epon onu port 1 ctc vlan mode tag ${destinationOlt.PPOE}`);
      } else {
        config.push('no epon onu port 1 ctc vlan mode');
      }
      pppoeONUs.push(onu);  // Додаємо ONU до масиву PPPoE
      pppoeCount++;
    } else if (oldVlan == sourceOlt.OPENSVIT) {
      config.push(destInterface);
      config.push(`epon onu port 1 ctc vlan mode tag ${destinationOlt.OPENSVIT}`);
      opensvitCount++;
    } else if (oldVlan == sourceOlt.pvid) {
      config.push(destInterface);
      if (destinationOlt.PPOE) {
        config.push(`epon onu port 1 ctc vlan mode tag ${destinationOlt.PPOE}`);
      } else {
        config.push('no epon onu port 1 ctc vlan mode');
      }
      pvidCount++;
    } else if (isSpecialCase(oldVlan, onu.oldInterface)) {
      specialCasesONUs.push({
        newInterface: onu.newInterface,
        oldInterface: onu.oldInterface,
        oldVlan: oldVlan
      });
    } else {
      ipoeONUs.push(onu);
    }
  });

  // Записуємо основну конфігурацію у файл
  const fileName = `destination_olt_config_${userId}.txt`;
  const filePath = path.resolve(fileName);
  config.push("exit")
  config.push("exit")
  fs.writeFileSync(filePath, config.join('\n'));

  // Записуємо спеціальні випадки у окремий файл
  const specialCasesFileName = `special_cases_${userId}.txt`;
  const specialCasesFilePath = path.resolve(specialCasesFileName);
  if (specialCasesONUs.length > 0) {
    const specialCasesContent = specialCasesONUs.map(onu => 
      `New Interface: ${onu.newInterface}, Old Interface: ${onu.oldInterface}, Old VLAN: ${onu.oldVlan}`
    ).join('\n');
    fs.writeFileSync(specialCasesFilePath, specialCasesContent);
  } else {
    // Створюємо порожній файл, якщо немає спеціальних випадків
    fs.writeFileSync(specialCasesFilePath, '');
  }

  // Записуємо ONU без конфігурації у окремий файл
  const unconfiguredFileName = `unconfigured_onus_${userId}.txt`;
  const unconfiguredFilePath = path.resolve(unconfiguredFileName);
  if (unconfiguredONUs.length > 0) {
    const unconfiguredContent = unconfiguredONUs.map(onu => 
      `MAC: ${onu.mac}, Old Interface: ${onu.oldInterface}, New Interface: ${onu.newInterface}`
    ).join('\n');
    fs.writeFileSync(unconfiguredFilePath, unconfiguredContent);
  } else {
    // Створюємо порожній файл, якщо немає ONU без конфігурації
    fs.writeFileSync(unconfiguredFilePath, '');
  }

  return {
    configFile: filePath,
    ipoeONUs: ipoeONUs,
    pppoeONUs: pppoeONUs,  // Додаємо масив PPPoE ONU до результату
    specialCasesFile: specialCasesFilePath,
    specialCasesCount: specialCasesONUs.length,
    unconfiguredFile: unconfiguredFilePath,
    unconfiguredCount: unconfiguredCount,
    opensvitCount: opensvitCount,
    pvidCount: pvidCount,
    pppoeCount: pppoeCount
  };
}
 export async function updateMigratedONUsVlans(migratedONUs, sourceOlt) {
  // Створюємо Set для зберігання унікальних інтерфейсів ONU без VLAN
  const uniqueInterfaces = new Set();

  // Проходимо по migratedONUs і збираємо унікальні інтерфейси ONU без VLAN
  migratedONUs.forEach(onu => {
    if (!onu.oldVlans || onu.oldVlans.length === 0) {
      uniqueInterfaces.add(onu.oldInterface);
    }
  });

  // Якщо немає ONU без VLAN, повертаємо оригінальний масив
  if (uniqueInterfaces.size === 0) {
    return migratedONUs;
  }
  // Отримуємо всі VLAN для унікальних інтерфейсів за один запит
  const interfacesVlans = await takeMacVlans(sourceOlt.ID, Array.from(uniqueInterfaces));

  // Оновлюємо migratedONUs з отриманими VLAN
  const updatedMigratedONUs = migratedONUs.map(onu => {
    if (!onu.oldVlans || onu.oldVlans.length === 0) {
      const vlan = interfacesVlans[onu.oldInterface];
      if (vlan) {
        return { ...onu, oldVlans: [vlan] };
      }
    }
    return onu;
  });

  return updatedMigratedONUs;
}
export function processMultiportONUs(migratedONUs, sourceResult, destinationConfigFile, specialCasesFile) {
  const multiportONUs = [];
  const updatedMigratedONUs = [];
  let destinationConfig = [];
  let specialCases = [];
  const processedONUs = new Set(); // Set для відстеження вже оброблених ONU

  // Перевірка наявності файлів та їх читання
  if (destinationConfigFile && fs.existsSync(destinationConfigFile)) {
    destinationConfig = fs.readFileSync(destinationConfigFile, 'utf8').split('\n');
  } else {
    console.warn(`Warning: Destination config file not found or invalid: ${destinationConfigFile}`);
  }

  if (specialCasesFile && fs.existsSync(specialCasesFile)) {
    specialCases = fs.readFileSync(specialCasesFile, 'utf8').split('\n');
  } else {
    console.warn(`Warning: Special cases file not found or invalid: ${specialCasesFile}`);
  }

  // Перший прохід: обробка багатопортових ONU
  migratedONUs.forEach(onu => {
    const sourceONU = sourceResult.onuConfigs.find(sourceONU => sourceONU.mac === onu.mac);
    
    if (sourceONU && sourceONU.vlans.length > 1) {
      multiportONUs.push(onu);
      processedONUs.add(onu.mac);
      specialCases.push(`Multiport ONU:
      MAC: ${onu.mac}
      Old Interface: ${onu.oldInterface}
      New Interface: ${onu.newInterface}
      VLANs: ${sourceONU.vlans.join(', ')}`);
      
      // Видаляємо конфігурацію цієї ONU з destination файлу
      destinationConfig = destinationConfig.filter(line => !line.includes(onu.newInterface));
    } else {
      updatedMigratedONUs.push(onu);
    }
  });

  // Другий прохід: обробка спеціальних випадків, виключаючи вже оброблені багатопортові ONU
  const uniqueSpecialCases = [];
  specialCases.forEach(specialCase => {
    const macMatch = specialCase.match(/MAC: ([0-9A-Fa-f:.]+)/);
    if (macMatch) {
      const mac = macMatch[1];
      if (!processedONUs.has(mac)) {
        uniqueSpecialCases.push(specialCase);
        processedONUs.add(mac);
      }
    } else {
      // Якщо MAC не знайдено, зберігаємо спеціальний випадок як є
      uniqueSpecialCases.push(specialCase);
    }
  });

  // Оновлюємо specialCases, залишаючи тільки унікальні випадки
  specialCases = uniqueSpecialCases;

  // Записуємо оновлені конфігурації назад у файли, якщо вони існують
  if (destinationConfigFile) {
    fs.writeFileSync(destinationConfigFile, destinationConfig.join('\n'));
  }

  if (specialCasesFile) {
    fs.writeFileSync(specialCasesFile, specialCases.join('\n'));
  }

  return {
    updatedMigratedONUs,
    multiportONUs
  };
}
function isMultiportONU(config) {
  if (!config) return false;
  const lines = config.split('\n');
  const portConfigs = lines.filter(line => line.trim().startsWith('epon onu port'));
  const uniquePorts = new Set(portConfigs.map(line => line.split(' ')[4]));
  return uniquePorts.size > 1;
}
export async function getMigratedONUsMacs(migratedONUs, sourceOlt,ipoe=false) {
  // Створюємо масив для зберігання всіх інтерфейсів ONU
  const allInterfaces = migratedONUs.map(onu => onu.oldInterface);

  // Отримуємо MAC-адреси та VLAN для всіх інтерфейсів
  let interfacesMacsAndVlans
  if(ipoe){
   interfacesMacsAndVlans = await takeMacAddresses(sourceOlt.ID, allInterfaces);
  }else{
    interfacesMacsAndVlans = await takeMacAddressesP(sourceOlt.ID, allInterfaces);

  }

  // Створюємо новий масив об'єктів з інтерфейсами, MAC-адресами та VLAN
  const result = migratedONUs.map(onu => {
    const interfaceInfo = interfacesMacsAndVlans[onu.oldInterface] || {};
    return {
      interface: onu.oldInterface,
      macOnu: onu.mac, // MAC-адреса ONU з migratedONUs
      mac: interfaceInfo.mac || null, // MAC-адреса з takeMacAddresses
      vlan: interfaceInfo.vlan || null // VLAN з takeMacAddresses
    };
  });

  return result;
}
export function processIpoeONUs(customerInfo, ipoeONUs, destinationPvid) {
  return ipoeONUs.map(ipoeONU => {
    const customer = customerInfo.find(c => c.interface === ipoeONU.oldInterface);
    
    let ipoeVlan;
    const [, sfp, onuNumber] = ipoeONU.newInterface.match(/EPON0\/(\d+):(\d+)/);
    
    if (parseInt(onuNumber) <= 9) {
      ipoeVlan = parseInt(`${sfp}0${onuNumber}`);
    } else {
      ipoeVlan = parseInt(`${sfp}${onuNumber}`);
    }

    return {
      newInterface: ipoeONU.newInterface,
      login: customer ? customer.login : null,
      billing_id: customer ? customer.billing_id : null,
      server_vlan: destinationPvid,
      ipoeVlan: ipoeVlan,
      mac: customer ? customer.mac : null // Використовуємо MAC з customerInfo
    };
  });
}
export async function updateBillingData(processedIpoeONUs, destinationOltPvid) {
  const updatedONUs = [];
  const errors = [];

  for (const onu of processedIpoeONUs) {
    if (onu.billing_id) {
      try { 
        const sql = `UPDATE internet_main SET vlan = ${onu.ipoeVlan}, server_vlan = ${destinationOltPvid} WHERE uid = ${onu.billing_id}`;
        await queryDatabaseBilling(sql);
        updatedONUs.push(onu);
      } catch (error) {
        console.error(`Error updating billing data for ONU ${onu.billing_id}:`, error);
        errors.push({ onu, error: error.message });
      }
    }
  }

  return { updatedONUs, errors };
}
export async function updateBillingDataSingle(uid, ipoeVlan, destinationOltPvid, newMacAddress) {
  try {
    const sql = `UPDATE internet_main SET vlan = ${ipoeVlan}, server_vlan = ${destinationOltPvid}, cid = '${newMacAddress}' WHERE uid = ${uid}`;
    await queryDatabaseBilling(sql);
    return { success: true, message: `
    ✅ *Успішне оновлення даних в білінгу*
    🔄 Статус: Завершено
    📊 Операція: Оновлення даних користувача
    ✨ Дані успішно синхронізовано з системою білінгу.` 
      };
  } catch (error) {
    console.error(`Error updating billing data for ONU ${uid}:`, error);
    return { success: false, message: `Помилка оновлення даних в білінгу: ${error.message}` };
  }
}
function formatMac(mac) {
  // Видаляємо всі не-алфавітні та не-цифрові символи
  const cleanMac = mac.replace(/[^a-fA-F0-9]/g, '');
  // Розділяємо на групи по 4 символи та з'єднуємо крапками
  return cleanMac.match(/.{1,4}/g).join('.');
}
export async function resetSessions(processedIpoeONUs) {
  const successfulResets = [];
  const failedResets = [];

  for (const onu of processedIpoeONUs) {
    if (onu.billing_id && onu.mac) {
      try {
        const formattedMac = formatMac(onu.mac);
        // Отримуємо інформацію про сесію з бази даних
        const sql = `SELECT user_name, nas_port_id, acct_session_id, nas_id FROM internet_online WHERE cid='${formattedMac}'`;
        const sessionInfo = await queryDatabaseBilling(sql);

        if (sessionInfo.length > 0) {
          const session = sessionInfo[0];
          
          // Виконуємо POST-запит для скидання сесії
          const response = await fetch(`https://billing.intelekt.cv.ua:9443/api.cgi/internet/${onu.billing_id}/session/hangup`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'KEY': 'ij8knawoygsyirralsulvEnMafdaf'
            },
            body: JSON.stringify({
              acctSessionId: session.acct_session_id,
              nasId: session.nas_id,
              nasPortId: session.nas_port_id,
              userName: session.user_name
            })
          });

          const result = await response.json();

          if (result.result === "OK") {
            successfulResets.push(onu);
          } else {
            failedResets.push(onu);
          }
        } else {
          failedResets.push(onu);
        }
      } catch (error) {
        console.error(`Error resetting session for ONU ${onu.billing_id}:`, error);
        failedResets.push(onu);
      }
    }
  }

  return { successfulResets, failedResets };
}
export async function resetSessionSingle(uid, newMacAddress) {
  try {
    // Отримуємо інформацію про сесію з бази даних
    const sql = `SELECT user_name, nas_port_id, acct_session_id, nas_id FROM internet_online WHERE uid=${uid}`;
    const sessionInfo = await queryDatabaseBilling(sql);

    if (sessionInfo.length > 0) {
      const session = sessionInfo[0];
      
      // Виконуємо POST-запит для скидання сесії
      const response = await fetch(`https://billing.intelekt.cv.ua:9443/api.cgi/internet/${uid}/session/hangup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'KEY': 'ij8knawoygsyirralsulvEnMafdaf'
        },
        body: JSON.stringify({
          acctSessionId: session.acct_session_id,
          nasId: session.nas_id,
          nasPortId: session.nas_port_id,
          userName: session.user_name
        })
      });

      const result = await response.json();

      if (result.result === "OK") {
        return { success: true, message: 'Сесію успішно скинуто' };
      } else {
        return { success: false, message: 'Не вдалося скинути сесію' };
      }
    } else {
      return { success: false, message: 'Активну сесію не знайдено' };
    }
  } catch (error) {
    console.error(`Error resetting session for ONU ${uid}:`, error);
    return { success: false, message: `Помилка скидання сесії: ${error.message}` };
  }
}
export function writeIpoeDataToFile(processedIpoeONUs, userId, destinationOltPvid) {
  const fileName = `ipoe_data_${userId}.html`;
  const filePath = path.resolve(fileName);
  
  let fileContent = `
<!DOCTYPE html>
<html lang="uk">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IPoE ONU Data</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            padding: 20px;
            background-color: #f9f9f9;
            color: #333;
        }
        h1, h2 {
            color: #2c3e50;
            border-bottom: 2px solid #27ae60;
            padding-bottom: 10px;
        }
        .onu-container {
            display: flex;
            flex-wrap: wrap;
            gap: 20px;
            justify-content: space-around;
        }
        .onu-item {
            padding: 15px;
            margin-bottom: 15px;
            width: calc(33% - 20px);
           
        }
        .onu-item:hover {
            box-shadow: 12px 12px 12px rgba(0,0,0,0.1) inset,
            -10px -10px 10px white inset;
        }
        .onu-item p {
            margin: 5px 0;
        }
        .onu-item strong {
            color: #16a085;
        }
        .stats {
            background-color: #e8f6f3;
            border-radius: 8px;
            padding: 15px;
            margin-top: 30px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }
        a {
            color: #27ae60;
            text-decoration: none;
            transition: color 0.3s ease;
        }
        a:hover {
            color: #219653;
        }
        a:visited {
            color: #8e44ad;
        }
        .update-button {
            background-color: #4CAF50;
            border: none;
            color: white;
            padding: 15px 32px;
            text-align: center;
            text-decoration: none;
            display: inline-block;
            font-size: 16px;
            margin: 4px 2px;
            cursor: pointer;
        }
        @media (max-width: 768px) {
            .onu-item {
                width: 100%;
            }
        }
    </style>
</head>
<body>
    <h1>Дані IPoE ONU</h1>
  `;
  
  const unidentifiedONUs = [];
  const identifiedONUs = [];

  processedIpoeONUs.forEach(onu => {
    if (!onu.login || !onu.billing_id) {
      unidentifiedONUs.push(onu);
    } else {
      identifiedONUs.push(onu);
    }
  });

  // Додаємо неідентифіковані ONU
  if (unidentifiedONUs.length > 0) {
    fileContent += '<h2>Неідентифіковані IPoE абоненти</h2>';
    fileContent += '<div class="onu-container">';
    unidentifiedONUs.forEach(onu => {
      fileContent += `
        <div class="onu-item">
          <p><strong>MAC:</strong> ${onu.mac || 'Невідомо'}</p>
          <p><strong>Новий інтерфейс:</strong> ${onu.newInterface}</p>
          <p><strong>IPoE VLAN:</strong> ${onu.ipoeVlan}</p>
        </div>
      `;
    });
    fileContent += '</div>';
  }

  // Додаємо ідентифіковані ONU
  if (identifiedONUs.length > 0) {
    fileContent += '<h2>Ідентифіковані IPoE абоненти</h2>';
    fileContent += '<div class="onu-container">';
    identifiedONUs.forEach(onu => {
      fileContent += `
        <div class="onu-item">
          <p><strong>Новий інтерфейс:</strong> ${onu.newInterface}</p>
          <p><strong>Логін:</strong> ${onu.login}</p>
          <p><strong>MAC:</strong> ${onu.mac || 'Невідомо'}</p>
          <p><strong>Server VLAN:</strong> ${onu.server_vlan}</p>
          <p><strong>IPoE VLAN:</strong> ${onu.ipoeVlan}</p>
          <p><strong>Білінг:</strong> <a href="https://billing.intelekt.cv.ua/admin/index.cgi?index=15&UID=${onu.billing_id}" target="_blank">Відкрити в білінгу</a></p>
        </div>
      `;
    });
    fileContent += '</div>';
  }

  // Додаємо статистику
  fileContent += `
    <div class="stats">
      <h2>Загальна статистика IPoE абонентів</h2>
      <p><strong>Загальна кількість IPoE ONU:</strong> ${processedIpoeONUs.length}</p>
      <p><strong>Ідентифіковано:</strong> ${identifiedONUs.length}</p>
      <p><strong>Не ідентифіковано:</strong> ${unidentifiedONUs.length}</p>
    </div>
  `;

  // Додаємо кнопку для оновлення даних у білінгу
 

  fileContent += `
    </body>
    </html>
  `;

  fs.writeFileSync(filePath, fileContent);
  
  return filePath;
}
export function writePppoeDataToFile(processedPppoeONUs, userId) {
  const fileName = `pppoe_data_${userId}.html`;
  const filePath = path.resolve(fileName);
  
  let fileContent = `
<!DOCTYPE html>
<html lang="uk">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PPPoE ONU Data</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            padding: 20px;
            background-color: #f0f0f0;
            color: #333;
        }
        h1, h2 {
            color: #2c3e50;
            border-bottom: 2px solid #3498db;
            padding-bottom: 10px;
        }
        .onu-container {
            display: flex;
            flex-wrap: wrap;
            gap: 20px;
            justify-content: space-around;
        }
        .onu-item {
            background-color: #fff;
            border: 1px solid #ddd;
            border-radius: 8px;
            padding: 15px;
            margin-bottom: 15px;
            width: calc(33% - 20px);
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
            transition: box-shadow 0.3s ease;
        }
        .onu-item:hover {
            box-shadow: 0 5px 15px rgba(0,0,0,0.2);
        }
        .onu-item p {
            margin: 5px 0;
        }
        .onu-item strong {
            color: #2980b9;
        }
        .stats {
            background-color: #ecf0f1;
            border-radius: 8px;
            padding: 15px;
            margin-top: 30px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }
        a {
            color: #3498db;
            text-decoration: none;
            transition: color 0.3s ease;
        }
        a:hover {
            color: #2980b9;
        }
        a:visited {
            color: #8e44ad;
        }
        @media (max-width: 768px) {
            .onu-item {
                width: 100%;
            }
        }
    </style>
</head>
<body>
    <h1>Дані PPPoE ONU</h1>
  `;
  
  const unidentifiedONUs = [];
  const identifiedONUs = [];

  processedPppoeONUs.forEach(onu => {
    if (!onu.login || !onu.billing_id) {
      unidentifiedONUs.push(onu);
    } else {
      identifiedONUs.push(onu);
    }
  });

  // Додаємо неідентифіковані ONU
  if (unidentifiedONUs.length > 0) {
    fileContent += '<h2>Неідентифіковані PPPoE абоненти</h2>';
    fileContent += '<div class="onu-container">';
    unidentifiedONUs.forEach(onu => {
      fileContent += `
        <div class="onu-item">
          <p><strong>MAC:</strong> ${onu.mac || 'Невідомо'}</p>
          <p><strong>Новий інтерфейс:</strong> ${onu.newInterface}</p>
          <p><strong>PPPoE VLAN:</strong> ${onu.pppoeVlan || 'Невідомо'}</p>
        </div>
      `;
    });
    fileContent += '</div>';
  }

  // Додаємо ідентифіковані ONU
  if (identifiedONUs.length > 0) {
    fileContent += '<h2>Ідентифіковані PPPoE абоненти</h2>';
    fileContent += '<div class="onu-container">';
    identifiedONUs.forEach(onu => {
      fileContent += `
        <div class="onu-item">
          <p><strong>Новий інтерфейс:</strong> ${onu.newInterface}</p>
          <p><strong>Логін:</strong> ${onu.login}</p>
          <p><strong>MAC:</strong> ${onu.mac || 'Невідомо'}</p>
          <p><strong>Білінг:</strong> <a href="https://billing.intelekt.cv.ua/admin/index.cgi?index=15&UID=${onu.billing_id}" target="_blank">Відкрити в білінгу</a></p>
        </div>
      `;
    });
    fileContent += '</div>';
  }

  // Додаємо статистику
  fileContent += `
    <div class="stats">
      <h2>Загальна статистика PPPoE абонентів</h2>
      <p><strong>Загальна кількість PPPoE ONU:</strong> ${processedPppoeONUs.length}</p>
      <p><strong>Ідентифіковано:</strong> ${identifiedONUs.length}</p>
      <p><strong>Не ідентифіковано:</strong> ${unidentifiedONUs.length}</p>
    </div>
  `;

  fileContent += `
    </body>
    </html>
  `;

  fs.writeFileSync(filePath, fileContent);
  
  return filePath;
}
export { uploadsDir };
const execAsync = promisify(exec);
export async function searchOnuConfig(macAddress, userId) {
  const archivePath = path.join(uploadsDir, `${userId}.zip`);
  const tempDir = path.join(uploadsDir, `temp_${userId}`);

  try {
    // Створюємо тимчасову директорію і розпаковуємо архів
    await execAsync(`mkdir -p "${tempDir}" && unzip -q "${archivePath}" -d "${tempDir}"`);

    // Шукаємо MAC-адресу у всіх файлах running-config.conf
    const { stdout: macResult } = await execAsync(`grep -r "epon bind-onu mac ${macAddress}" "${tempDir}"`);

    if (!macResult) {
      return "Інформацію про ONU не знайдено.";
    }

    const configFile = macResult.split(':')[0];
    const configContent = await fs.promises.readFile(configFile, 'utf8');

    // Знаходимо інтерфейс ONU
    const interfaceMatch = configContent.match(new RegExp(`interface (EPON0/\\d+)[\\s\\S]*?epon bind-onu mac ${macAddress} (\\d+)`));
    if (!interfaceMatch) {
      return "Не вдалося визначити інтерфейс ONU.";
    }
    const onuInterface = `${interfaceMatch[1]}:${interfaceMatch[2]}`;

    // Шукаємо IP-адресу OLT
    const ipMatch = configContent.match(/interface VLAN\d+\s+ip address (\d+\.\d+\.\d+\.\d+)/);
    const oltIp = ipMatch ? ipMatch[1] : "IP-адресу OLT не знайдено";

    return `ONU Interface: ${onuInterface}\nOLT IP: ${oltIp}`;
  } catch (error) {
    console.error('Помилка при пошуку конфігурації ONU:', error);
    return `Виникла помилка при пошуку конфігурації ONU: ${error.message}`;
  } finally {
    // Видаляємо тимчасову директорію
    await execAsync(`rm -rf "${tempDir}"`).catch(console.error);
  }
}
export async function sendAnimatedWaitingMessage(chatId, bot) {
  const stages = [
    '🔍 Отримання інформації про OLT',
    '🔍 Отримання інформації про OLT .',
    '🔍 Отримання інформації про OLT ..',
    '🔍 Отримання інформації про OLT ...'
  ];
  
  const message = await bot.sendMessage(chatId, stages[0], { parse_mode: 'Markdown' });
  
  let currentStage = 0;
  const intervalId = setInterval(() => {
    currentStage = (currentStage + 1) % stages.length;
    bot.editMessageText(stages[currentStage], {
      chat_id: chatId,
      message_id: message.message_id,
      parse_mode: 'Markdown'
    });
  }, 500);

  return {
    stop: () => {
      clearInterval(intervalId);
      bot.editMessageText('✅ Інформацію про OLT отримано!', {
        chat_id: chatId,
        message_id: message.message_id,
        parse_mode: 'Markdown'
      });
    }
  };
}


export  async function askForSourceSfp(bot,chatId, userState) {
  const message = `
🔢 *Введення номера SFP для першої OLT*
Будь ласка, введіть номер SFP першої OLT:
📊 Доступний діапазон: від 1 до ${userState.sourceOlt.maxSfp}
  `;

  await bot.sendMessage(chatId, message, { 
    parse_mode: 'Markdown',
   
  });

  // Додаткове повідомлення з прикладом

}

// Для другої OLT
export async function askForDestinationSfp(bot,chatId, userState) {
  const message = `
🔢 *Введення номера SFP для другої OLT*
Будь ласка, введіть номер SFP другої OLT:
📊 Доступний діапазон: від 1 до ${userState.destinationOlt.maxSfp}
  `;

  await bot.sendMessage(chatId, message, { 
    parse_mode: 'Markdown',
    
  });

  // Додаткове повідомлення з нагадуванням

}
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function retryWithBackoff(operation, retries = 5, backoff = 300) {
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      return await operation();
    } catch (error) {
      if (error.message.includes('ETELEGRAM: 429')) {
        console.log(`Attempt ${i + 1} failed, retrying in ${backoff}ms`);
        await wait(backoff);
        backoff *= 2; // Експоненціальне збільшення затримки
        lastError = error;
      } else {
        throw error; // Якщо помилка не пов'язана з обмеженням швидкості, пробросити її далі
      }
    }
  }

  throw lastError;
}

export { retryWithBackoff };