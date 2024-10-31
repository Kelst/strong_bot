import dotenv from 'dotenv';
import fetch from 'node-fetch';
import mysql from 'mysql2/promise';
import fs from 'fs/promises';
import path from 'path';
dotenv.config();
const url = process.env.API_URL;
const api_key = process.env.API_KEY;
function calculateMaxSfp(data) {
  let maxSfp = 0;
  const ifaces = data.ifaces;
  for (const key in ifaces) {
    const ifDescr = ifaces[key].ifDescr;
    if (ifDescr.startsWith('EPON0/')) {
      const sfpNumber = parseInt(ifDescr.split('/')[1]);
      if (sfpNumber > maxSfp) {
        maxSfp = sfpNumber;
      }
    }
  }
  return maxSfp;
}
async function takeInfoById(idDevice) {
    const GET1 = {
        key: api_key,
        cat: 'device',
        action: 'get_data',
        object_type: 'olt',
        object_id: idDevice,
    };

    const params = new URLSearchParams(GET1);
    const response = await fetch(`${url}?${params}`);
    const data = await response.json();
    let OPENSVIT;

    if (data && data.data && data.data[idDevice] && data.data[idDevice].additional_data && data.data[idDevice].additional_data['134']) {
        OPENSVIT = data.data[idDevice].additional_data['134'];
    } else {
        OPENSVIT = undefined;
    }    
    // console.log('Raw API response:', JSON.stringify(data, null, 2));

    if (!data.data || !data.data[idDevice]) {
        throw new Error(`No data found for device ID: ${idDevice}`);
    }

    const deviceData = data.data[idDevice];
    const maxSfp = calculateMaxSfp(deviceData);

    return {
        olt_sfp: maxSfp,
        telnet_login: deviceData.telnet_login || '',
        telnet_pass: deviceData.telnet_pass || '',
        OPENSVIT:OPENSVIT
    };
}
async function takeIdDevice(ip) {
    const GET1 = {
        key: api_key,
        cat: 'device',
        action: 'get_device_id',
        object_type: 'switch',
        data_typer: "ip",
        data_value: ip,
    };

    const params = new URLSearchParams(GET1);
    const response = await fetch(`${url}?${params}`);
    const data = await response.json();

    // console.log('Raw API response for takeIdDevice:', JSON.stringify(data, null, 2));

    if ('error' in data) {
        return 'Немає olt з такою ip';
    }

    if (!data.id) {
        throw new Error(`No device ID found for IP: ${ip}`);
    }

    // console.log('Device ID:', data.id);

    const dictDevice = await takeInfoById(data.id.toString());
    dictDevice.ID= data.id
    // console.log('Device Info:', dictDevice);

    if (dictDevice.telnet_login === "" || dictDevice.telnet_pass === "") {
        return 'Потрібно актуалізувати дані про олт в юзері';
    }

    return dictDevice;
}
async function takeMacVlans(oltId, interfaces) {
    const GET1 = {
      key: api_key,
      cat: 'device',
      action: 'get_mac_list',
      object_type: 'switch',
      object_id: oltId,
    };
  
    const params = new URLSearchParams(GET1);
    const response = await fetch(`${url}?${params}`);
    const data = await response.json();
  
    // console.log('list_mac:', JSON.stringify(data.data, null, 2));
  
    if (!data.data || !Array.isArray(data.data)) {
      console.error('Unexpected data format');
      return {};
    }
  
    const result = {};
  
    interfaces.forEach(intOnu => {
      const filteredData = data.data.filter(item => item.port === intOnu);
      if (filteredData.length > 0) {
        filteredData.sort((a, b) => new Date(b.date_last) - new Date(a.date_last));
        result[intOnu] = filteredData[0].vlan_id;
      }
    });
  
    return result;
  }
  async function takeMacAddressesP(oltId, interfaces) {
    const GET1 = {
      key: api_key,
      cat: 'device',
      action: 'get_mac_list',
      object_type: 'switch',
      object_id: oltId,
    };
  
    const params = new URLSearchParams(GET1);
    const response = await fetch(`${url}?${params}`);
    const data = await response.json();
  
    if (!data.data || !Array.isArray(data.data)) {
      console.error('Unexpected data format');
      return {};
    }
  
    const result = {};
  
    // Функція для обчислення IPoE VLAN з порту
    const calculateIpoeVlan = (port) => {
      const match = port.match(/EPON0\/(\d+):(\d+)/);
      if (match) {
        const [, sfp, onu] = match;
        const onuNumber = parseInt(onu);
        return onuNumber <= 9 ? parseInt(`${sfp}0${onu}`) : parseInt(`${sfp}${onu}`);
      }
      return null;
    };
  
    interfaces.forEach(intOnu => {
      const filteredData = data.data.filter(item => item.port === intOnu);
      if (filteredData.length > 0) {
        // Сортуємо за датою (від найновішої до найстарішої)
        filteredData.sort((a, b) => new Date(b.date_last) - new Date(a.date_last));
        
        const latestDate = new Date(filteredData[0].date_last);
        const itemsWithLatestDate = filteredData.filter(item => new Date(item.date_last).getTime() === latestDate.getTime());
        
        if (itemsWithLatestDate.length > 1) {
          // Якщо є кілька записів з однаковою найновішою датою
          const ipoeVlan = calculateIpoeVlan(intOnu);
          
          // Спочатку шукаємо не-IPoE запис
          const nonIpoeItem = itemsWithLatestDate.find(item => parseInt(item.vlan_id) !== ipoeVlan);
          
          if (nonIpoeItem) {
            result[intOnu] = {
              mac: nonIpoeItem.mac,
              vlan: nonIpoeItem.vlan_id
            };
          } else {
            // Якщо всі записи - IPoE, вибираємо перший
            result[intOnu] = {
              mac: itemsWithLatestDate[0].mac,
              vlan: itemsWithLatestDate[0].vlan_id
            };
          }
        } else {
          // Якщо тільки один запис з найновішою датою
          result[intOnu] = {
            mac: filteredData[0].mac,
            vlan: filteredData[0].vlan_id
          };
        }
      }
    });
  
    return result;
  }
   async function takeMacAddresses(oltId, interfaces) {
    const GET1 = {
      key: api_key,
      cat: 'device',
      action: 'get_mac_list',
      object_type: 'switch',
      object_id: oltId,
    };
  
    const params = new URLSearchParams(GET1);
    const response = await fetch(`${url}?${params}`);
    const data = await response.json();
  
    if (!data.data || !Array.isArray(data.data)) {
      console.error('Unexpected data format');
      return {};
    }
  
    const result = {};
  
    // Функція для обчислення IPoE VLAN з порту
    const calculateIpoeVlan = (port) => {
      const match = port.match(/EPON0\/(\d+):(\d+)/);
      if (match) {
        const [, sfp, onu] = match;
        const onuNumber = parseInt(onu);
        return onuNumber <= 9 ? parseInt(`${sfp}0${onu}`) : parseInt(`${sfp}${onu}`);
      }
      return null;
    };
  
    interfaces.forEach(intOnu => {
      const filteredData = data.data.filter(item => item.port === intOnu);
      if (filteredData.length > 0) {
        // Сортуємо за датою (від найновішої до найстарішої)
        filteredData.sort((a, b) => new Date(b.date_last) - new Date(a.date_last));
        
        const latestDate = new Date(filteredData[0].date_last);
        const itemsWithLatestDate = filteredData.filter(item => new Date(item.date_last).getTime() === latestDate.getTime());
        
        if (itemsWithLatestDate.length > 1) {
          // Якщо є кілька записів з однаковою найновішою датою
          const ipoeVlan = calculateIpoeVlan(intOnu);
          const matchingVlanItem = itemsWithLatestDate.find(item => parseInt(item.vlan_id) === ipoeVlan);
          
          if (matchingVlanItem) {
            result[intOnu] = {
              mac: matchingVlanItem.mac,
              vlan: matchingVlanItem.vlan_id
            };
          } else {
            // Якщо немає відповідного VLAN, беремо перший елемент
            result[intOnu] = {
              mac: itemsWithLatestDate[0].mac,
              vlan: itemsWithLatestDate[0].vlan_id
            };
          }
        } else {
          // Якщо тільки один запис з найновішою датою
          result[intOnu] = {
            mac: filteredData[0].mac,
            vlan: filteredData[0].vlan_id
          };
        }
      }
    });
  
    return result;
  }
export { takeIdDevice, takeInfoById,takeMacVlans,takeMacAddresses,takeMacAddressesP };
async function logToFile(message) {
  const logDir = 'logs';
  const logFile = path.join(logDir, `api_log_${new Date().toISOString().split('T')[0]}.log`);
  
  try {
    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(logFile, `${new Date().toISOString()} - ${message}\n`);
  } catch (error) {
    console.error('Error writing to log file:', error);
  }
}
export async function getCustomerInfo(macsData) {
  const results = [];
  const customerIds = [];
  const macToDataMap = new Map();

  // console.log(`Starting processing for ${macsData.length} MAC addresses`);

  // Перший прохід: отримуємо всі customer_id
  for (const item of macsData) {
    try {
      const GET1 = {
        key: api_key,
        cat: 'customer',
        action: 'get_abon_id',
        data_typer: 'mac',
        data_value: item.mac,
      };

      const params1 = new URLSearchParams(GET1);
      const response1 = await fetch(`${url}?${params1}`);
      const data1 = await response1.json();

      if (data1.result === "OK" && data1.Id) {
        const customerId = parseInt(data1.Id);
        customerIds.push(customerId);
        macToDataMap.set(customerId, item);
        console.log(`Found customer ID ${customerId} for MAC ${item.mac}`);
      } else {
        console.log(`No customer ID found for MAC ${item.mac}`);
      }
    } catch (error) {
      console.error(`Error processing item: ${item.mac}`, error);
    }
  }

  console.log(`Found ${customerIds.length} customer IDs`);

  // Другий прохід: отримуємо дані всіх користувачів за один запит
  if (customerIds.length > 0) {
    try {
      const GET2 = {
        key: api_key,
        cat: 'customer',
        action: 'get_data',
        customer_id: customerIds.join(','),
      };

      const params2 = new URLSearchParams(GET2);
      const response2 = await fetch(`${url}?${params2}`);
      const data2 = await response2.json();

      // console.log('get_data response:', JSON.stringify(data2, null, 2));

      if (data2.result == "OK" && data2.data) {
        const processCustomerData = (customerData) => {
          const customerId = customerData.id;
          const originalData = macToDataMap.get(customerId);
          
          if (originalData) {
            // console.log(`Processing customer data for ID ${customerId}`);
            
            results.push({
              interface: originalData.interface,
              macOnu: originalData.macOnu,
              mac: originalData.mac,
              vlan: originalData.vlan,
              login: customerData.login,
              billing_id: customerData.billing_id,
            });
            // console.log(`Added result for customer ID ${customerId}`);
          } else {
            console.log(`No original data found for customer ID ${customerId}`);
          }
        };

        // Обробляємо дані в залежності від формату відповіді
        if (typeof data2.data === 'object' && !Array.isArray(data2.data)) {
          if (data2.data.id) {
            // Випадок з однією ONU
            processCustomerData(data2.data);
          } else {
            // Випадок з кількома ONU
            Object.values(data2.data).forEach(processCustomerData);
          }
        } else if (Array.isArray(data2.data)) {
          // Альтернативний випадок з однією ONU (масив з одним елементом)
          data2.data.forEach(processCustomerData);
        } else {
          console.log('Unexpected data format in get_data response');
        }
      } else {
        console.log('Invalid or empty response from get_data');
      }
    } catch (error) {
      console.error('Error fetching customer data:', error);
    }
  }

  // console.log(`Identified ${results.length} out of ${macsData.length} customers`);
  return results;
}
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
export async function queryDatabaseBilling(sql) {
    try {
      const [rows, fields] = await pool.query(sql);
      return rows;
    } catch (err) {
      console.error('Error executing query:', err);
      throw err;
    }
  }
  
  export async function getUserBillingData(login) {
    try {
      // Перший запит для отримання uid
      const uidQuery = `SELECT uid FROM users WHERE id = '${login}'`;
      const uidResult = await queryDatabaseBilling(uidQuery);
  
      if (uidResult.length === 0) {
        return null; // Користувача не знайдено
      }
  
      const uid = uidResult[0].uid;
  
      // Другий запит для отримання коментарів
      const commentsQuery = `SELECT comments FROM users_pi WHERE uid = '${uid}'`;
      const commentsResult = await queryDatabaseBilling(commentsQuery);
  
      const comments = commentsResult.length > 0 ? commentsResult[0].comments : null;
  
      return {
        uid,
        login,
        comments
      };
    } catch (error) {
      console.error("Error in getUserBillingData:", error);
      throw error;
    }
  }

  export async function getOntData(mac) {
    const GET1 = {
      key: api_key,
      cat: 'device',
      action: 'get_ont_data',
      id: mac
    };
  
    const params = new URLSearchParams(GET1);
    const response = await fetch(`${url}?${params}`);
    const data = await response.json();
  
    if (data.result === "OK" && data.data) {
      const { iface_name, device_id, level_onu_rx } = data.data;
      return { iface_name, device_id, level_onu_rx };
    }
  
    return null;
  }
  
  export async function getOntData1(mac) {
    const GET1 = {
      key: api_key,
      cat: 'device',
      action: 'get_ont_data',
      id: mac
    };
  
    const params = new URLSearchParams(GET1);
    const response = await fetch(`${url}?${params}`);
    const data = await response.json();
  
    if (data.result === "OK" && data.data) {
      const { iface_name, device_id, level_onu_rx } = data.data;
      return { iface_name, device_id, level_onu_rx };
    }
  
    return null;
  }
  
  export async function getOltData1(deviceId) {
    const GET2 = {
      key: api_key,
      cat: 'device',
      action: 'get_data',
      object_type: 'olt',
      object_id: deviceId
    };
  
    const params = new URLSearchParams(GET2);
    const response = await fetch(`${url}?${params}`);
    const data = await response.json();
  
    if (data.result === "OK" && data.data) {
      const oltData = Object.values(data.data)[0];
      const { host, telnet_login, telnet_pass } = oltData;
      return { host, telnet_login, telnet_pass };
    }
  
    return null;
  }