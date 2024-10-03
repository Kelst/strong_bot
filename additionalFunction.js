import fs from 'fs';
import path from 'path';
import { searchOnuConfig } from './tools.js';

export function generateSfpTemplates(chatId, bot, sfpNumber) {
    try {
      // Генеруємо конфігурацію
      const config = generateSfpConfig(sfpNumber);
      
      // Зберігаємо конфігурацію у файл
      const fileName = `sfp_template_${sfpNumber}.txt`;
      const filePath = path.join(process.cwd(), fileName);
      fs.writeFileSync(filePath, config);
      
      // Відправляємо файл користувачу
      bot.sendDocument(chatId, filePath, { caption: `Темплейт для SFP ${sfpNumber}` })
        .then(() => {
          // Видаляємо тимчасовий файл після відправки
          fs.unlinkSync(filePath);
          bot.sendMessage(chatId, 'Генерація темплейту завершена успішно.');
        })
        .catch((error) => {
          console.error('Помилка при відправці файлу:', error);
          bot.sendMessage(chatId, 'Виникла помилка при відправці файлу.');
        });
    } catch (error) {
      console.error('Помилка при генерації темплейту:', error);
      bot.sendMessage(chatId, `Виникла помилка при генерації темплейту: ${error.message}`);
    }
  }
  
  function generateSfpConfig(sfpNumber) {
    let config = `interface EPON0/${sfpNumber}\n`;
    
    for (let i = 64; i >= 1; i--) {
      const param = i <= 9 ? `${sfpNumber}0${i}` : `${sfpNumber}${i}`;
      config += ` epon pre-config-template T1 binded-onu-llid ${i} param ${param}\n`;
    }
    
    return config;
  }
  
  export function configurePppoeVlan(chatId, bot) {
    bot.sendMessage(chatId, 'Будь ласка, введіть MAC-адресу ONU (формат: e0e8.e6ff.5e07):');
    
    bot.once('text', async (msg) => {
      const macAddress = msg.text.trim();
      const userId = msg.from.id;
      
      if (/^([0-9A-Fa-f]{4}\.){2}[0-9A-Fa-f]{4}$/.test(macAddress)) {
        bot.sendMessage(chatId, 'Шукаю інформацію про ONU...');
        
        try {
          const result = await searchOnuConfig(macAddress, userId);
          bot.sendMessage(chatId, result);
        } catch (error) {
          console.error('Помилка при пошуку конфігурації ONU:', error);
          bot.sendMessage(chatId, `Виникла помилка при пошуку конфігурації ONU: ${error.message}`);
        }
      } else {
        bot.sendMessage(chatId, 'Невірний формат MAC-адреси. Будь ласка, спробуйте ще раз.');
      }
    });
  }
  
  export function configureIpoeVlan() {
    // Реалізація налаштування IPoE VLAN
  }
  
 