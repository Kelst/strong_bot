import fs from 'fs';
import path from 'path';
import { resetSessionSingle, searchOnuConfig, updateBillingDataSingle } from './tools.js';
import { getOltData1, getOntData1, getUserBillingData } from './api.js';
import { configureAndCheckOnu, restartOnuPort } from './telnet.js';

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
  
  export async function resetGuestSesion(chatId, bot) {
    const userId = chatId;
  
    const isValidLogin = (login) => /^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};:'",.<>?]+$/.test(login);
    const isValidMac = (mac) => /^([0-9A-Fa-f]{4}[.]){2}[0-9A-Fa-f]{4}$/.test(mac);
  
    // Функція для повернення до головного меню
    const returnToMainMenu = async () => {
      await bot.sendMessage(chatId, 'Повертаємось до головного меню', {
        reply_markup: {
          keyboard: [
            ['Згенерувати темплейти для SFP'],
            ['Скинути гостьову']
          ],
          resize_keyboard: true,
          one_time_keyboard: false
        }
      });
    };
  
    await bot.sendMessage(chatId, `
    🔐 *Введення логіну користувача*
    
    Будь ласка, введіть логін користувача з дотриманням наступних правил:
    
    • Використовуйте лише *англійські букви*
    • Можна використовувати *цифри*
    • Дозволені *спеціальні символи*
    • ❗️ Без пробілів
    
    _Приклад: user123 або user_name_2023_
    
    Введіть ваш логін:
    `, { parse_mode: 'Markdown' });
  
    bot.once('message', async (msg) => {
      const login = msg.text.trim();
      if (!isValidLogin(login)) {
        await bot.sendMessage(chatId, "Невірний формат логіну. Спробуйте ще раз, використовуючи англійські букви, цифри та спеціальні символи без пробілів.");
        return resetGuestSesion(chatId, bot);
      }
  
      try {
        const billingData = await getUserBillingData(login);
        if (billingData) {
          const { uid, comments, login: userLogin } = billingData;
          let responseMessage = `
  📊 *Дані користувача*
  👤 *Логін:* \`${userLogin}\`
  🆔 *UID:* \`${uid}\`
  💬 *Коментарі:* ${comments ? `\n\n\`\`\`\n${comments}\n\`\`\`` : '_Відсутні_'}
          `;
  
          await bot.sendMessage(chatId, responseMessage, { parse_mode: 'Markdown' });
  
          const macMatches = comments ? comments.match(/([0-9A-Fa-f]{4}[.]){2}[0-9A-Fa-f]{4}/g) : null;
          let selectedMac;
  
          if (macMatches && macMatches.length > 0) {
            if (macMatches.length === 1) {
              selectedMac = macMatches[0];
              await bot.sendMessage(chatId, `Знайдено MAC-адресу ONU в коментарях: ${selectedMac}`);
            } else {
              const keyboard = macMatches.map(mac => [{ text: mac }]);
              const reply_markup = { keyboard, one_time_keyboard: true, resize_keyboard: true };
              await bot.sendMessage(chatId, "Знайдено кілька MAC-адрес. Будь ласка, виберіть потрібну:", { reply_markup });
              
              const macResponse = await new Promise(resolve => bot.once('message', resolve));
              selectedMac = macResponse.text.trim();
              
              if (!macMatches.includes(selectedMac)) {
                await bot.sendMessage(chatId, "Вибрано некоректну MAC-адресу. Повертаємось до головного меню.");
                return returnToMainMenu();
              }
            }
          } else {
            await bot.sendMessage(chatId, "MAC-адресу ONU не знайдено в коментарях. Будь ласка, введіть MAC-адресу ONU вручну (формат: XXXX.XXXX.XXXX):");
            
            const macResponse = await new Promise(resolve => bot.once('message', resolve));
            selectedMac = macResponse.text.trim();
            
            if (!isValidMac(selectedMac)) {
              await bot.sendMessage(chatId, "Введено некоректну MAC-адресу. Повертаємось до головного меню.");
              return returnToMainMenu();
            }
          }
  
          // Продовжуємо з вибраною MAC-адресою
          const ontData = await getOntData1(selectedMac);
          if (ontData && ontData.iface_name && ontData.device_id && ontData.level_onu_rx !== undefined) {
            const oltData = await getOltData1(ontData.device_id);
            if (oltData && oltData.host && oltData.telnet_login && oltData.telnet_pass) {
              await bot.sendMessage(chatId, "Налаштування ONU...");
              
              try {
                const { vlan, macAddress: newMacAddress, activeOnu, pvid } = await configureAndCheckOnu(
                  oltData.host,
                  oltData.telnet_login,
                  oltData.telnet_pass,
                  ontData.iface_name
                );
            
                let statusMessage = `
            📡 *Результати налаштування ONU*
            🔌 *Інтерфейс:* \`${ontData.iface_name}\`
            🔢 *VLAN:* \`${vlan}\`
               *Pvid:* \`${pvid}\`
            📊 *Рівень сигналу:* \`${ontData.level_onu_rx} dBm\`
            🖥️ *IP OLT:* \`${oltData.host}\`
            🔗 *Статус ONU:* ${activeOnu ? '🟢 На зв\'язку' : '🔴 Не на зв\'язку'}
            💻 *MAC-адреса:* \`${newMacAddress || 'Не знайдено'}\`
                `;
            
                await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
            
                if (activeOnu && newMacAddress) {
                  // Оновлення даних в білінгу
                  const billingUpdateResult = await updateBillingDataSingle(billingData.uid, vlan, pvid, newMacAddress);
                  await bot.sendMessage(chatId, billingUpdateResult.message);
            
                  // Скидання сесії
                  const sessionResetResult = await resetSessionSingle(billingData.uid, newMacAddress);
                  await bot.sendMessage(chatId,`
                  🔄 *Перезавантаження порту ONU*
                  
                  📡 Інтерфейс: \`${ontData.iface_name}\`
                  
                  ⏳ Процес:
                  1. Вимкнення порту
                  2. Очікування (2 секунди)
                  3. Увімкнення порту
                  🕒 Будь ласка, зачекайте. Це може зайняти кілька секунд...
                  `);
                 const result=await restartOnuPort( oltData.host,
                  oltData.telnet_login,
                  oltData.telnet_pass,
                  ontData.iface_name)
                  function formatOnuRestartMessage(sessionResetResult, result) {
                    const sessionStatus = sessionResetResult.success ? '✅' : '❌';
                    
                    let message = `
                  🔄 *ONU Restart Results*
                  
                  ${sessionStatus} *Session Reset:* ${sessionResetResult.message}
                  
                  *ONU Configuration:*
                  \`\`\`
                  ${JSON.stringify(result, null, 2)}
                  \`\`\`
                  `;
                  
                    return message.trim();
                  }
                  const formattedMessage = formatOnuRestartMessage(sessionResetResult, result);

                  await bot.sendMessage(chatId, formattedMessage, { parse_mode: 'Markdown' });
                } else {
                  await bot.sendMessage(chatId, "⚠️ ONU не на зв'язку або MAC-адресу не знайдено. Неможливо оновити дані в білінгу та скинути сесію.");
                }
            
              } catch (error) {
                console.error("Помилка при налаштуванні ONU:", error);
                await bot.sendMessage(chatId, `⚠️ Виникла помилка при налаштуванні ONU: ${error.message}`);
              }
            } else {
              await bot.sendMessage(chatId, "❌ Не вдалося отримати дані OLT.");
            }
          } else {
            await bot.sendMessage(chatId, "❌ Не вдалося отримати дані ONU.");
          }
        } else {
          await bot.sendMessage(chatId, "❌ Користувача з таким логіном не знайдено.");
        }
      } catch (error) {
        console.error("Помилка при отриманні даних:", error);
        await bot.sendMessage(chatId, "⚠️ Виникла помилка при отриманні даних. Будь ласка, спробуйте пізніше.");
      }
  
      // Повертаємось до головного меню після завершення всіх операцій
      returnToMainMenu();
    });
  }
  export function configureIpoeVlan() {
    // Реалізація налаштування IPoE VLAN
  }
  
 