import dotenv from 'dotenv';
import fs from 'fs';
import express from 'express';

import path from 'path';
import TelegramBot from 'node-telegram-bot-api';
import { userHasArchive, showMenu, saveFile, OltData, isValidIp, isValidSfp, processArchive, pingHost, processMigratedONUs, generateCleanupConfig, generateMigrationConfig, updateMigratedONUsVlans, processMultiportONUs, getMigratedONUsMacs, processIpoeONUs, writeIpoeDataToFile, searchOnuConfig, writePppoeDataToFile,updateBillingData, resetSessions, sendAnimatedWaitingMessage, askForSourceSfp, askForDestinationSfp } from './tools.js';
import { getCustomerInfo, queryDatabaseBilling, takeIdDevice } from './api.js';
import { checkOnuStatus, cleanupSfp, configureDestinationOlt, configureOpensvitVlan, getNameOlt, getOnuPowerLevels } from './telnet.js';
import { getTelnetConfig } from './telnet.js';
import { PPOE } from './constJS.js';
import {  generateSfpTemplates, resetGuestSesion, configureIpoeVlan} from './additionalFunction.js';

dotenv.config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const URL = process.env.WEBHOOK_URL; // URL вашого сервера
const PORT = process.env.PORT || 3033;

const app = express();
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL}/bot${TOKEN}`);
console.log(`${URL}/bot${TOKEN}`);
app.use(express.json());
app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});
const userStates = new Map();




function resetUserState(userId) {
  userStates.set(userId, {
    mode: 'main',
    step: 'source_ip',
    sourceOlt: new OltData(),
    destinationOlt: new OltData(),
    waitingForSfpNumber: false // Новий прапорець
  });
}


async function proceedToNextStep(chatId, userId) {
  const userState = userStates.get(userId);
  if (userState.step === 'source_ip' || userState.step === 'source_name') {
    userState.step = 'source_sfp';
   await askForSourceSfp(bot,chatId, userState);
  } else if (userState.step === 'destination_ip' || userState.step === 'destination_name') {
    userState.step = 'destination_sfp';
  await  askForDestinationSfp(bot,chatId, userState);
  }
  showMenu(bot, chatId, true, false, true, false, 'main');
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userStates.mode='main'
  console.log('start');
  bot.sendMessage(chatId, 'Виберіть режим роботи:', {
    reply_markup: {
      keyboard: [
        ['Перенесення конфігів'],
        ['Додаткові опції']
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  });
});
bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  
  bot.sendMessage(chatId, 'Виберіть режим роботи:', {
    reply_markup: {
      keyboard: [
        ['Перенесення конфігів'],
        ['Додаткові опції']
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  });
});

bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const userId = callbackQuery.from.id;

 if (callbackQuery.data === 'update_billing_ipoe') {
  const userState = userStates.get(userId);
  
  if (userState && userState.processedIpoeONUs && userState.destinationOlt) {
    await bot.answerCallbackQuery(callbackQuery.id, {text: 'Оновлюю дані в білінгу та скидаю сесії...'});
    
    try {
      const updateResult = await updateBillingData(userState.processedIpoeONUs, userState.destinationOlt.pvid);
      
      let responseMessage = `Оновлено ${updateResult.updatedONUs.length} записів у білінгу.`;
      if (updateResult.errors.length > 0) {
        responseMessage += `\nВиникли помилки для ${updateResult.errors.length} записів.`;
      }

      // Викликаємо нову функцію resetSessions
      const resetResult = await resetSessions(userState.processedIpoeONUs);
      
      responseMessage += `\n\nСкинуто сесій: ${resetResult.successfulResets.length}`;
      responseMessage += `\nНе вдалося скинути сесій: ${resetResult.failedResets.length}`;
      await bot.editMessageCaption(responseMessage, {
        chat_id: chatId,
        message_id: messageId
      });
    } catch (error) {
      console.error('Помилка при оновленні даних в білінгу або скиданні сесій:', error);
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Виникла помилка при оновленні даних в білінгу або скиданні сесій.',
        show_alert: true
      });
    }
  } else {
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'Неможливо оновити дані. Інформація про IPoE ONU відсутня.',
      show_alert: true
    });
  }
}else   if (callbackQuery.data === 'cleanup_sfp') {
    const userId = callbackQuery.from.id;
    const cleanupConfigFile = `source_olt_cleanup_${userId}.txt`;
    const userState = userStates.get(userId);

    if (userState && userState.sourceOlt && userState.sourceOlt.ip) {
      await bot.editMessageCaption('Очищую SFP, почекайте будь ласка...', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] }
      });

      try {
        const result = await cleanupSfp(
          userState.sourceOlt.ip,
          userState.sourceOlt.telnetLogin,
          userState.sourceOlt.telnetPass,
          cleanupConfigFile
        );

        await bot.editMessageCaption('SFP очищено', {
          chat_id: chatId,
          message_id: messageId
        });

        await bot.sendMessage(chatId, result);
      } catch (error) {
        console.error('Помилка при очищенні SFP:', error);
        await bot.sendMessage(chatId, `Виникла помилка при очищенні SFP: ${error.message}`);
      }
    } else {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Неможливо виконати очищення. Дані OLT відсутні.',
        show_alert: true
      });
    }
  } else if (callbackQuery.data === 'configure_destination_olt') {
    const userId = callbackQuery.from.id;
    const destinationConfigFile = `destination_olt_config_${userId}.txt`;
    const userState = userStates.get(userId);
    if (userState && userState.destinationOlt && userState.destinationOlt.ip) {
      await bot.editMessageCaption('Налаштовую destination OLT, почекайте будь ласка...', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] }
      });
      try { 
        if(userState.destinationOlt.OPENSVIT)
    {   let confOpen= await configureOpensvitVlan(userState.destinationOlt.ip,
        userState.destinationOlt.telnetLogin,
        userState.destinationOlt.telnetPass,
        userState.destinationOlt.pvid,          
        userState.destinationOlt.OPENSVIT,     
        userState.destinationOlt.sfp) 
        console.log(confOpen);}
        const result = await configureDestinationOlt(
          userState.destinationOlt.ip,
          userState.destinationOlt.telnetLogin,
          userState.destinationOlt.telnetPass,
          destinationConfigFile
        );
       

        await bot.editMessageCaption('Destination OLT налаштовано', {
          chat_id: chatId,
          message_id: messageId
        });
        let responseMessage = result.message;

        // if (result.missingVlansMessage) {
        //   responseMessage += `\n\n${result.missingVlansMessage}`;
        // }

        // if (result.vlansNotOnSfpMessage) {
        //   responseMessage += `\n\n${result.vlansNotOnSfpMessage}`;
        // }

        await bot.sendMessage(chatId, responseMessage);

        if (result.unavailableONUs && result.unavailableONUs.length > 0) {
          const unavailableONUsMessage = `Наступні ONU були недоступні під час конфігурації:\n${result.unavailableONUs.join('\n')}`;
          await bot.sendMessage(chatId, unavailableONUsMessage);
          
          // Зберігаємо лог недоступних ONU у файл
          const logFileName = `unavailable_onus_${userId}.txt`;
          fs.writeFileSync(logFileName, unavailableONUsMessage);
          await bot.sendDocument(chatId, logFileName, { caption: 'Лог недоступних ONU' });
          fs.unlinkSync(logFileName); // Видаляємо тимчасовий файл після відправки
        }
      } catch (error) {
        console.error('Помилка при налаштуванні destination OLT:', error);
        await bot.sendMessage(chatId, `Виникла помилка при налаштуванні destination OLT: ${error.message}`);
      }
    } else {
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: 'Неможливо виконати налаштування. Дані destination OLT відсутні.',
        show_alert: true
      });
    }
  }
});
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const file = msg.document;

  if (file.mime_type !== 'application/zip' && file.mime_type !== 'application/x-zip-compressed') {
    bot.sendMessage(chatId, 'Будь ласка, відправте архів у форматі ZIP.');
    return;
  }

  bot.sendMessage(chatId, 'Починаю завантаження архіву. Це може зайняти кілька хвилин...');

  try {
    const fileInfo = await bot.getFile(file.file_id);
    const downloadUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;
    
    const fileName = await saveFile(downloadUrl, userId);

    const archiveExists = userHasArchive(userId);
    const actionMessage = archiveExists ? 'оновлено' : 'завантажено';

    bot.sendMessage(chatId, `Архів успішно ${actionMessage} та збережено як ${fileName}.`);
    
    // Скидаємо стан користувача та починаємо процес збору даних спочатку
    resetUserState(userId);
    
    bot.sendMessage(chatId, 'Процес розпочато з початку. Будь ласка, введіть IP-адресу першої OLT, з якої переносять конфіг:');
    userStates.get(userId).step = 'source_ip';
    showMenu(bot, chatId, true);
  } catch (error) {
    console.error('Помилка при обробці файлу:', error);
    bot.sendMessage(chatId, 'Виникла помилка при обробці файлу. Будь ласка, спробуйте ще раз.');
  }
});

bot.on('text', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;
  console.log('Отримано повідомлення:', JSON.stringify(msg, null, 2));

  if (!userStates.has(userId)) {
    resetUserState(userId);
  }

  const userState = userStates.get(userId);

  if (text === '/menu') {
    // Ігноруємо обробку, оскільки вона вже оброблена в bot.onText(/\/menu/, ...)
    return;
  }
  if (text === '/start') {
    // Ігноруємо обробку, оскільки вона вже оброблена в bot.onText(/\/menu/, ...)
    return;
  }

  if (text === 'Перенесення конфігів') {
    userState.mode = 'main';
    userState.step = 'start';
    userState.waitingForSfpNumber = false;
    const message = `
    🔄 *Режим перенесення конфігів активовано* 🔄
    
    📋 Цей режим дозволяє вам:
    • Перенести конфігурації між OLT
    • Автоматизувати процес міграції ONU
    • Оновити налаштування для абонентів
    
    🚀 Для початку роботи виберіть опцію в меню нижче.
    
    ⚠️ _Будь ласка, переконайтеся, що у вас є всі необхідні дані перед початком процесу._
      `;
      
       
       if (userHasArchive(userId)) {
      showMenu(bot, chatId, true);
    } else {
      bot.sendMessage(chatId, 'Будь ласка, відправте архів з конфігами OLT.');
    }
  } else if (text === 'Додаткові опції') {
    userState.mode = 'additional';
    userState.waitingForSfpNumber = false;
    showAdditionalMenu(chatId);
  } else if (userState.mode === 'main') {
  if (text === 'Перенести конфіг' || text === 'Опрацювати'||text==='Почати з початку') {
    if(text==='Почати з початку'){
      console.log("FFF");
      resetUserState(userId);
      userState.step = 'source_ip';
            // await bot.sendMessage(chatId, 'Процес розпочато з початку. Будь ласка, введіть IP-адресу першої OLT, з якої переносять конфіг:', {
      //   reply_markup: {
      //     keyboard: [
      //       ['❓ Інструкція'],
      //       ['🔙 Повернутися до головного меню']
      //     ],
      //     resize_keyboard: true,
      //     one_time_keyboard: false
      //   }
      // });
    }
    if (userHasArchive(userId)) {
      if (userState.step === 'completed') {
        showMenu(bot, chatId, false, false, true, false);
        let statusMessage;
      
        try {
          statusMessage = await bot.sendMessage(chatId, '🔄 Починаю опрацювання конфігурації. Це може зайняти кілька хвилин...', {
            reply_markup: { remove_keyboard: true }
          });
      
          const updateStatus = async (text) => {
            try {
              await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: statusMessage.message_id
              });
            } catch (error) {
              console.error('Помилка при оновленні статусу:', error);
              // Якщо не вдалося відредагувати, відправляємо нове повідомлення
              statusMessage = await bot.sendMessage(chatId, text);
            }
          };
      
          await updateStatus('📊 Обробляю конфігурацію першої OLT...');
          const sourceResult = await processArchive(userId, userState.sourceOlt);
          userState.sourceOlt.pvid = sourceResult.pvid;
      
          await updateStatus('🔍 Перевіряю доступність другої OLT...');
          const isDestinationOltReachable = await pingHost(userState.destinationOlt.ip);
          if (!isDestinationOltReachable) {
            await bot.sendMessage(chatId, `❌ OLT на яку перейшли ONU (${userState.destinationOlt.ip}) не на зв'язку. Будь ласка, перевірте з'єднання та спробуйте знову.`);
            return;
          }
          
          await updateStatus('📥 Отримую конфігурацію другої OLT...');
          console.log(userState.destinationOlt.telnetLogin,
            userState.destinationOlt.telnetPass);
          
          const destinationConfig = await getTelnetConfig(
            userState.destinationOlt.ip,
            userState.destinationOlt.telnetLogin,
            userState.destinationOlt.telnetPass,
            userState.destinationOlt.sfp,
            userState.destinationOlt.maxSfp
          );
      console.log(destinationConfig,"destinationConfig");
          await updateStatus('📊 Обробляю конфігурацію другої OLT...');
          const destinationResult = await processArchive(userId, userState.destinationOlt, destinationConfig);
          userState.destinationOlt.pvid = destinationResult.pvid;
          
          // Обробка мігрованих ONU
          const migratedONUs1 = processMigratedONUs(sourceResult, destinationResult);
          const updatedMigratedONUs = await updateMigratedONUsVlans(migratedONUs1, userState.sourceOlt);
          
          const macs = await getMigratedONUsMacs(migratedONUs1, userState.sourceOlt, true);
          const macsP = await getMigratedONUsMacs(migratedONUs1, userState.sourceOlt);
          const customerInfo = await getCustomerInfo(macs);
          const customerInfoP = await getCustomerInfo(macsP);
          
          // Додаємо старий конфіг до кожної ONU
          const migratedONUs = updatedMigratedONUs.map(onu => {
            const sourceONU = sourceResult.onuConfigs.find(sourceONU => sourceONU.mac === onu.mac);
            return {
              ...onu,
              oldConfig: sourceONU ? sourceONU.config : 'Недоступно'
            };
          });
          userState.migratedONUs = migratedONUs;
      
          const formatOltSummary = (olt, result) => `
          🔹 *${olt.name}*
             SFP: ${olt.sfp}
            ${olt.OPENSVIT ? `OPENSVIT_VLAN: ${olt.OPENSVIT}` : ''}
             Знайдено конфігурацій ONU: ${result.onuConfigs.length}
             ${result.diagnosticInfo}`;
          
          const createSummary = (userState, sourceResult, destinationResult, migratedONUs) => `
          📊 *Результати обробки:*
      
          ${formatOltSummary(userState.sourceOlt, sourceResult)}
      
          ${formatOltSummary(userState.destinationOlt, destinationResult)}
      
          📡 *Мігровані ONU:* ${migratedONUs.length}
          `;
      
          let summary = createSummary(userState, sourceResult, destinationResult, migratedONUs);
          summary = summary.replace(/([_*\[\]()~`>#+=|{}.!-])/g, '\\$1');
      
          // Видаляємо статусне повідомлення
          try {
            await bot.deleteMessage(chatId, statusMessage.message_id);
          } catch (error) {
            console.error('Помилка при видаленні статусного повідомлення:', error);
          }
      
          const maxLength = 4000;
          for (let i = 0; i < summary.length; i += maxLength) {
            const chunk = summary.slice(i, i + maxLength);
            await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
          }
      
          await bot.sendMessage(chatId, 'Виберіть наступну дію:', {
            reply_markup: {
              keyboard: [['Почати з початку']],
              resize_keyboard: true,
              one_time_keyboard: false
            }
          });
      
          if (migratedONUs.length > 0) {
            const result = generateMigrationConfig(migratedONUs, userState.sourceOlt, userState.destinationOlt, msg.from.id);
            const cleanupConfigFile = generateCleanupConfig(migratedONUs, userState.sourceOlt, msg.from.id);
            
            const processedIpoeONUs = processIpoeONUs(customerInfo, result.ipoeONUs, userState.destinationOlt.pvid);
            const processedPppoeONUs = processIpoeONUs(customerInfoP, result.pppoeONUs, userState.destinationOlt.pvid);
            
            userState.processedIpoeONUs = processedIpoeONUs;
          console.log(userState.destinationOlt.pvid,"userState.destinationOlt.pvid");  
            const filePath = writeIpoeDataToFile(processedIpoeONUs, msg.from.id, userState.destinationOlt.pvid);
            const pppoeFilePath = writePppoeDataToFile(processedPppoeONUs, userId);
            
            const { updatedMigratedONUs, multiportONUs } = processMultiportONUs(
              migratedONUs, 
              sourceResult, 
              result.configFile, 
              result.specialCasesFile
            );          
            
            result.specialCasesCount += multiportONUs.length;
            const pppoeCount = updatedMigratedONUs.length - result.ipoeONUs.length - result.specialCasesCount - result.opensvitCount;
            
            const migrationSummary = `
            📊 *Результат міграції ONU:*
            🔢 Загальна кількість мігрованих ONU: ${migratedONUs.length}
            🌐 Кількість IPOE ONU: ${result.ipoeONUs.length}
            🔐 Кількість PPPoE ONU: ${result.pppoeONUs.length}
            📡 Кількість OPENSVIT ONU: ${result.opensvitCount}
            🔌 Кількість багатопортових ONU: ${multiportONUs.length}
            ❓ Кількість ONU без конфігурації: ${result.unconfiguredCount}
            ${result.specialCasesCount > 0 ? `⚠️ Кількість спеціальних випадків: ${result.specialCasesCount}` : ''}
            `;
          
            await bot.sendMessage(chatId, migrationSummary, { parse_mode: 'Markdown' });
          
            const sendFileIfExists = async (filePath, caption) => {
              if (filePath && fs.existsSync(filePath)) {
                const fileContent = fs.readFileSync(filePath, 'utf8');
                if (fileContent.trim() !== '') {
                  let options = {
                    caption: caption,
                    parse_mode: 'Markdown'
                  };
            
                  if (caption === 'Конфігурація для очистки source OLT:') {
                    options.reply_markup = {
                      inline_keyboard: [[
                        { text: "Очистити SFP від ONU", callback_data: "cleanup_sfp" }
                      ]]
                    };
                  } else if (caption === 'Конфігурація для destination OLT:') {
                    options.reply_markup = {
                      inline_keyboard: [[
                        { text: "Налаштувати destination OLT", callback_data: "configure_destination_olt" }
                      ]]
                    };
                  } else if (caption === 'Дані IPoE ONU:') {
                    options.reply_markup = {
                      inline_keyboard: [[
                        { text: "Записати в білінг нові дані", callback_data: "update_billing_ipoe" }
                      ]]
                    };
                  }
                  
                  await bot.sendDocument(chatId, filePath, options);
                } else {
                  console.log(`File ${filePath} is empty, skipping.`);
                  await bot.sendMessage(chatId, `${caption} (файл порожній)`);
                }
              }
            };
      
            await sendFileIfExists(cleanupConfigFile, 'Конфігурація для очистки source OLT:');
            await sendFileIfExists(result.configFile, 'Конфігурація для destination OLT:');
            await sendFileIfExists(result.specialCasesFile, 'Деталі спеціальних випадків:');
            await sendFileIfExists(filePath, 'Дані IPoE ONU:');
            await sendFileIfExists(pppoeFilePath, 'Дані PPPOE ONU:');
            await sendFileIfExists(result.unconfiguredFile, 'ONU без конфігурації:');
      
            showMenu(bot, chatId, true, false, true, true);
          }
        } catch (error) {
          console.error('Помилка при обробці конфігурацій:', error);
          await bot.sendMessage(chatId, `❌ Виникла помилка при обробці конфігурацій: ${error.message}`);
          showMenu(bot, chatId, false, false, false, false);
        }
      } else {
        userState.step = 'source_ip';
        const message = `
        🖥️ *Введення IP-адреси першої OLT*
        Будь ласка, введіть IP-адресу першої OLT, з якої будуть переноситися конфігурації.
        📝 *Формат*: xxx.xxx.xxx.xxx
        🔍 Після введення IP-адреси система автоматично спробує отримати інформацію про OLT.
          `;
        
          await bot.sendMessage(chatId, message, { 
            parse_mode: 'Markdown',
          
          });       
          showMenu(bot, chatId, true, false, true, false, 'main');      }
    } else {
      bot.sendMessage(chatId, 'Спочатку вам потрібно завантажити архів з конфігами. Будь ласка, відправте архів у форматі ZIP.');
    }
  }else if (text === 'Перевірити статус ONU') {
    if (userState.step === 'completed' && userState.migratedONUs && userState.migratedONUs.length > 0) {
      bot.sendMessage(chatId, '🔍 Перевіряю статус ONU. Це може зайняти кілька хвилин...');
      try {
        const onuMacs = userState.migratedONUs.map(onu => onu.mac);
        console.log(userState.migratedONUs, "userState.migratedONUs");
        console.log(onuMacs);
        let onuStatuses = await checkOnuStatus(
          userState.destinationOlt.ip,
          userState.destinationOlt.telnetLogin,
          userState.destinationOlt.telnetPass,
          onuMacs
        );
         console.log(onuStatuses, "WQWWWWWWWWWWWwwwwwwwwweeeeee");
  
        let activeONUs = onuStatuses.filter(onu => onu.deregReason == 'auto-configured'||onu.deregReason == 'igured');
   if(activeONUs.length==0){
    activeONUs = onuStatuses.filter(onu => onu.status == 'auto-configured'||onu.status == 'igured');
    activeONUs=activeONUs.map(e=>{
      return {...e,deregReason:e.status}
    })
    onuStatuses=onuStatuses.map(e=>{
      return {...e,deregReason:e.status}
    })
   }
        let powerLevels = [];
        try {
          powerLevels = await getOnuPowerLevels(
            activeONUs,
            userState.destinationOlt.ip,
            userState.destinationOlt.telnetLogin,
            userState.destinationOlt.telnetPass,
            (current, total) => {
              console.log(`Progress: ${current}/${total}`);
              // Тут ви можете оновлювати інтерфейс користувача з прогресом
            }
          );
          console.log(powerLevels);
        } catch (error) {
          console.error('Error getting ONU power levels:', error);
        }
  
        // Створюємо Map для швидкого доступу до рівнів потужності за інтерфейсом
        const powerLevelsMap = new Map(powerLevels.map(pl => [pl.interface, pl.receivedPower]));
  
        // Створюємо повідомлення для користувача
        let statusMessage = '📊 *Статус мігрованих ONU:*\n\n';
        statusMessage += `🟢 Активні ONU: *${activeONUs.length}*\n`;
        statusMessage += `🔴 Неактивні ONU: *${onuStatuses.length-activeONUs.length}*\n`;
        statusMessage += `📡 Загальна кількість ONU: *${onuStatuses.length}*\n`;
  
        // Створюємо детальний звіт у файлі
        let detailedReport = '📋 Детальний звіт про статус ONU:\n\n';
        onuStatuses.forEach((onu, index) => {
          detailedReport += `🔹 ONU ${index + 1}:\n`;
          detailedReport += `   📍 Інтерфейс: ${onu.interface}\n`;
          detailedReport += `   🔑 MAC: ${onu.mac}\n`;
          detailedReport += `   🚦 Статус: ${onu.deregReason === 'auto-configured'||onu.deregReason === 'igured' ? '🟢 Активна' : '🔴 Неактивна'}\n`;
          
          // Додаємо інформацію про рівень потужності, якщо вона доступна
          const powerLevel = powerLevelsMap.get(onu.interface);
          if (powerLevel !== undefined) {
            detailedReport += `   📶 Рівень потужності: ${powerLevel} dBm\n`;
          } else {
            detailedReport += `   📶 Рівень потужності: Недоступний\n`;
          }
          
          detailedReport += '\n';
        });
  
        // Зберігаємо детальний звіт у файл
        const fileName = `onu_status_report_${msg.from.id}.txt`;
        const __dirname = path.dirname(fileName);
        const filePath = path.join(__dirname, fileName);
        fs.writeFileSync(filePath, detailedReport);
  
        // Відправляємо повідомлення та файл користувачу
        await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
        await bot.sendDocument(chatId, filePath, { caption: '📄 Детальний звіт про статус ONU' });
  
        // Видаляємо файл після відправки
        fs.unlinkSync(filePath);
      } catch (error) {
        console.error('Помилка при перевірці статусу ONU:', error);
        bot.sendMessage(chatId, `❌ Виникла помилка при перевірці статусу ONU: ${error.message}`);
      }
      showMenu(bot, chatId, true, false, true, true);
    } else {
      bot.sendMessage(chatId, '⚠️ Спочатку потрібно виконати процес міграції ONU.');
      showMenu(bot, chatId, false, false, false, false);
    }
  }
  //   else if (text === 'Почати з початку') {
  //   resetUserState(userId);
  //   // bot.sendMessage(chatId, 'Процес розпочато з початку. Будь ласка, введіть IP-адресу першої OLT, з якої переносять конфіг:');
  //   userState.step = 'source_ip';
  //   showMenu(bot, chatId, true);
  // } 
  else {
    switch (userState.step) {
      case 'source_ip':
      case 'destination_ip':
        if (isValidIp(text)) {
          const waitingMessage = await sendAnimatedWaitingMessage(chatId, bot);
          
          try {
            const deviceInfo = await takeIdDevice(text);
            waitingMessage.stop();
        
            if (typeof deviceInfo === 'string') {
              await bot.sendMessage(chatId, `❌ *Помилка*: ${deviceInfo}`, { parse_mode: 'Markdown' });
              showMenu(bot, chatId, true);
            } else {
              const oltData = userState.step === 'source_ip' ? userState.sourceOlt : userState.destinationOlt;
              oltData.ip = text;
              if (PPOE[oltData.ip] !== undefined) {
                oltData.PPOE = PPOE[oltData.ip];
              }
              oltData.telnetLogin = deviceInfo.telnet_login;
              oltData.telnetPass = deviceInfo.telnet_pass;
              oltData.maxSfp = deviceInfo.olt_sfp;
              oltData.ID = deviceInfo.ID;
              oltData.OPENSVIT = deviceInfo.OPENSVIT;
        console.log( `
        ✅ *Інформацію про OLT успішно отримано!*
        
        📡 *IP-адреса*: \`${text}\`
        🔢 *Максимальна кількість SFP*: ${deviceInfo.olt_sfp}
        ${oltData.PPOE ? `🔐 *PPOE VLAN*: ${oltData.PPOE}` : ''}
        ${deviceInfo.OPENSVIT ? `🌐 *OPENSVIT VLAN*: ${deviceInfo.OPENSVIT}` : ''}
        
        _Отримую назву OLT..._
              `);
              await bot.sendMessage(chatId, `
        ✅ *Інформацію про OLT успішно отримано!*
        
        📡 *IP-адреса*: \`${text}\`
        🔢 *Максимальна кількість SFP*: ${deviceInfo.olt_sfp}
        ${oltData.PPOE ? `🔐 *PPOE VLAN*: ${oltData.PPOE}` : ''}
        ${deviceInfo.OPENSVIT ? `🌐 *OPENSVIT VLAN*: ${deviceInfo.OPENSVIT}` : ''}
        
        _Отримую назву OLT..._
              `, { parse_mode: 'Markdown' });
        
              try {
                console.log(`Attempting to get OLT name for ${oltData.ip}`);
                oltData.name = await getNameOlt(oltData.ip, oltData.telnetLogin, oltData.telnetPass);
                console.log(`Successfully retrieved OLT name: ${oltData.name}`);
                
  
                await bot.sendMessage(chatId, `📛 *Назва OLT*: ${oltData.name}`, { parse_mode: 'HTML' });
                
               await proceedToNextStep(chatId, userId);
              } catch (error) {
                console.error('Error getting OLT name:', error);
                if (error.message === 'All password attempts failed') {
                  await bot.sendMessage(chatId, `❌ *Помилка*: Не вдалося підключитися до OLT ${oltData.ip}. Всі спроби введення пароля не вдалися.`, { parse_mode: 'Markdown' });
                  showMenu(bot, chatId, true);
                } else {
                  userState.step = userState.step === 'source_ip' ? 'source_name' : 'destination_name';
                  await bot.sendMessage(chatId, `⚠️ *Увага*: Виникла помилка при отриманні назви OLT: ${error.message}. Будь ласка, введіть назву OLT вручну:`, { parse_mode: 'Markdown' });
                  showMenu(bot, chatId, true);
                }
              }
            }
          } catch (error) {
            waitingMessage.stop();
            console.error('Помилка при отриманні інформації про OLT:', error);
            await bot.sendMessage(chatId, `❌ *Помилка*: Виникла проблема при отриманні інформації про OLT. Будь ласка, спробуйте ще раз або зверніться до адміністратора.`, { parse_mode: 'Markdown' });
            showMenu(bot, chatId, true);
          }
        } else {
          await bot.sendMessage(chatId, '❌ *Помилка*: Неправильний формат IP-адреси. Будь ласка, введіть коректну IP-адресу:', { parse_mode: 'Markdown' });
          showMenu(bot, chatId, true);
        } 
        break;
      case 'source_name':
      case 'destination_name':
        const oltData = userState.step === 'source_name' ? userState.sourceOlt : userState.destinationOlt;
        oltData.name = text;
        console.log(`User entered OLT name: ${oltData.name}`);
       await proceedToNextStep(bot,chatId, userId);
        break;
        case 'source_sfp':
          if (isValidSfp(text, userState.sourceOlt.maxSfp)) {
            userState.sourceOlt.sfp = parseInt(text);
            userState.step = 'destination_ip';
            
            const successMessage = `
        ✅ *SFP успішно встановлено!*
        📊 Вибрано SFP номер: *${text}*
        🔄 Переходимо до наступного кроку...
        📝 Будь ласка, введіть IP-адресу другої OLT, на яку перейшли абоненти:
            `;
            
            await bot.sendMessage(chatId, successMessage, { 
              parse_mode: 'Markdown',
              
            });
            
            // Додаткове повідомлення-нагадування
            setTimeout(() => {
              bot.sendMessage(chatId, '🔍 Введіть IP-адресу другої OLT:');
            }, 1000);
            
          } else {
            const errorMessage = `
        ❌ *Помилка: Неправильний номер SFP*
        
        🔢 Будь ласка, введіть число від 1 до ${userState.sourceOlt.maxSfp}.
        
        ℹ️ _Переконайтеся, що ви вводите номер в межах допустимого діапазону._
            `;
            
            await bot.sendMessage(chatId, errorMessage, { 
              parse_mode: 'Markdown',
              reply_markup: {
                keyboard: [
                  ['🔙 Назад'],
                  ['❌ Скасувати операцію']
                ],
                resize_keyboard: true,
                one_time_keyboard: false
              }
            });
          }
          showMenu(bot, chatId, true);
          break;
      case 'destination_sfp':
        if (isValidSfp(text, userState.destinationOlt.maxSfp)) {
          userState.destinationOlt.sfp = parseInt(text);
          userState.step = 'completed';
          const formatMessage = (userState) => {
            const escapeMarkdown = (text) => {
              return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
            };
          
            const formatOltInfo = (olt) => `
          🔹 Назва: ${escapeMarkdown(olt.name)}
             IP: \`${olt.ip}\`
             PPPOE_VLAN: ${olt.PPOE !== 0 ? escapeMarkdown(olt.PPOE.toString()) : 'немає'}
             OPENSVIT_VLAN: ${olt.OPENSVIT ? escapeMarkdown(olt.OPENSVIT.toString()) : 'немає'}
             SFP: ${escapeMarkdown(olt.sfp.toString())}/${escapeMarkdown(olt.maxSfp.toString())}`;
          
            const message = `
          ✅ *Дані успішно зібрані:*
          
          *Перша OLT:*${formatOltInfo(userState.sourceOlt)}
          
          *Друга OLT:*${formatOltInfo(userState.destinationOlt)}
          
          Що бажаєте зробити далі?`;
          
            return message;
          };
          
          bot.sendMessage(chatId, formatMessage(userState), { parse_mode: 'Markdown' });
          showMenu(bot, chatId, true, true, true, false);


        } else {
          bot.sendMessage(chatId, `Неправильний номер SFP. Будь ласка, введіть число від 1 до ${userState.destinationOlt.maxSfp}:`);
          showMenu(bot, chatId, true);
        }
        break;
      default:
        if (userHasArchive(userId)) {
          bot.sendMessage(chatId, 'Будь ласка, використовуйте кнопки меню для вибору опцій.');
          showMenu(bot, chatId, true, false, true, false);        } else {
          bot.sendMessage(chatId, 'Будь ласка, відправте мені архів з конфігами OLT у форматі ZIP.');
        }
    }
  }
} else if (userState.mode === 'additional') {
  // Перевіряємо, чи текст відповідає одній з опцій меню
  if (['Згенерувати темплейти для SFP', 'Скинути гостьову'].includes(text)) {
    userState.waitingForSfpNumber = false;
    handleAdditionalOptions(chatId, text, userId);
  } else if (userState.waitingForSfpNumber) {
    handleSfpNumberInput(chatId, text, userId);
  } else {
    bot.sendMessage(chatId, 'Будь ласка, виберіть опцію з меню.');
  }
} else {
  bot.sendMessage(chatId, 'Будь ласка, виберіть режим роботи або використайте /menu для показу опцій.');
}
});

function showAdditionalMenu(chatId) {
  bot.sendMessage(chatId, 'Виберіть додаткову опцію:', {
    reply_markup: {
      keyboard: [
        ['Згенерувати темплейти для SFP'],
        ['Скинути гостьову'],
      ],
      // keyboard: [
      //   ['Згенерувати темплейти для SFP'],
      //   ['Прописати PPPoE VLAN'],
      //   ['Прописати IPoE VLAN'],
      //   ['Прописати Opensvit VLAN'],
      //   ['Повернутися до головного меню']
      // ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  });
}


function handleAdditionalOptions(chatId, option, userId) {
  const userState = userStates.get(userId);
  switch (option) {
    case 'Згенерувати темплейти для SFP':
      userState.waitingForSfpNumber = true;
      bot.sendMessage(chatId, 'Введіть номер SFP (від 1 до 16):');
      break;
       case 'Скинути гостьову':
        userState.waitingForSfpNumber = false;
        resetGuestSesion(chatId, bot);
        break;
      break;
    // case 'Прописати PPPoE VLAN':
    //   userState.waitingForSfpNumber = false;
    //   configurePppoeVlan(chatId, bot);
    //   break;
    // case 'Прописати IPoE VLAN':
    //   userState.waitingForSfpNumber = false;
    //   configureIpoeVlan(chatId, bot);
    //   break;
    // case 'Прописати Opensvit VLAN':
    //   userState.waitingForSfpNumber = false;
    //   configureOpensvitVlan(chatId, bot);
    //   break;
    case 'Повернутися до головного меню':
      userState.waitingForSfpNumber = false;
      bot.sendMessage(chatId, 'Виберіть режим роботи:', {
        reply_markup: {
          keyboard: [
            ['Перенесення конфігів'],
            ['Додаткові опції']
          ],
          resize_keyboard: true,
          one_time_keyboard: false
        }
      });
      break;
    default:
      bot.sendMessage(chatId, 'Невідома опція. Будь ласка, виберіть опцію з меню.');
  }
}

function handleSfpNumberInput(chatId, input, userId) {
  const userState = userStates.get(userId);
  const sfpNumber = parseInt(input);
  if (isNaN(sfpNumber) || sfpNumber < 1 || sfpNumber > 16) {
    bot.sendMessage(chatId, 'Невірний номер SFP. Будь ласка, введіть число від 1 до 16.');
  } else {
    userState.waitingForSfpNumber = false;
    generateSfpTemplates(chatId, bot, sfpNumber);
  }
}
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

console.log('Bot started with webhook');