const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

// ============================================================================
// 1. KAPI: OYUN BAŞLANGICI (Sunucu Kronometreyi Başlatır)
// ============================================================================
exports.startGame = functions.https.onCall(async (data, context) => {
    // Veritabanında geçici bir "Oturumlar" (sessions) tablosu oluşturuyoruz
    const sessionId = admin.firestore().collection('sessions').doc().id;
    
    // O anki gerçek sunucu saatini kaydediyoruz (Oyuncu bunu değiştiremez)
    await admin.firestore().collection('sessions').doc(sessionId).set({
        startTime: admin.firestore.FieldValue.serverTimestamp(),
        active: true
    });

    // Oyuncuya sadece elindeki "Oturum Anahtarını" (Bilet) veriyoruz
    return { sessionId: sessionId };
});

// ============================================================================
// 2. KAPI: OYUN BİTİŞİ VE SKOR HESAPLAMA (Karar Mercii)
// ============================================================================
exports.submitSecureScore = functions.https.onCall(async (request) => {
    // Gen2 (firebase-functions v7): ilk argüman { data, auth, rawRequest, ... }
    // Gen1: ilk argüman doğrudan istemci payload'ı — ikisini de destekle
    const payload = request && request.data !== undefined ? request.data : request;
    const { sessionId, nickname, attemptsCount, totalTilesMoved, totalGreenTiles, date, mode } = payload || {};

    // 1. GÜVENLİK KONTROLÜ: Oturum (Bilet) Geçerli mi?
    if (!sessionId) {
        throw new functions.https.HttpsError('unauthenticated', 'Bilet (Session) eksik!');
    }

    const sessionRef = admin.firestore().collection('sessions').doc(sessionId);
    const sessionDoc = await sessionRef.get();

    if (!sessionDoc.exists || !sessionDoc.data().active) {
        throw new functions.https.HttpsError('failed-precondition', 'Hile Tespit Edildi: Sahte veya kullanılmış oturum!');
    }

    // 2. GÜVENLİK KONTROLÜ: Gerçek Süre Hesaplama (Zaman Yolculuğu Engeli)
    const sessionData = sessionDoc.data();
    const startTime = sessionData.startTime.toDate();
    const endTime = new Date(); // Sunucunun o anki saati
    const finalTimeInSeconds = Math.floor((endTime - startTime) / 1000);

    // Oturumu anında kapatıyoruz ki hileci aynı biletle 2. kez skor yollamasın
    await sessionRef.update({ active: false });

    // 3. GÜVENLİK KONTROLÜ: Fiziksel Limitler (Speedhack Engeli)
    if (finalTimeInSeconds < 2) {
        throw new functions.https.HttpsError('out-of-range', 'Hile Tespit Edildi: İmkansız Süre.');
    }

    // Bir insan saniyede en fazla 6-7 kare hareket edebilir.
    // Eğer 10 saniyede 150 kare gitmişse hile yapıyordur.
    const movesPerSecond = totalTilesMoved / finalTimeInSeconds;
    if (movesPerSecond > 8) {
        throw new functions.https.HttpsError('out-of-range', 'Hile Tespit Edildi: İnsanlık dışı hız (Speedhack).');
    }

    // 4. GÜVENLİK KONTROLÜ: Veri Mantığı
    if (!nickname || nickname.trim().length === 0 || nickname.length > 15) {
        throw new functions.https.HttpsError('invalid-argument', 'Geçersiz İsim.');
    }
    if (attemptsCount < 1 || attemptsCount > 5) {
        throw new functions.https.HttpsError('invalid-argument', 'Geçersiz deneme sayısı.');
    }

    // --- SUNUCU TARAFLI PUAN HESAPLAMA ---
    // Yüzdeyi tarayıcıdan almak yerine hamle sayılarından sunucuda biz buluyoruz
    let avgPercent = 0;
    if (totalTilesMoved > 0) {
        avgPercent = Math.round((totalGreenTiles / totalTilesMoved) * 100);
    }
    if (avgPercent > 100) avgPercent = 100;

    const attemptBonus = (5 - attemptsCount + 1) * 20;
    const timePenalty = Math.min(finalTimeInSeconds * 0.5, 100);
    
    // Final skoru oyuncunun cihazında değil, BURADA hesaplandı.
    const finalCalculatedScore = Math.max(0, Math.round(avgPercent + attemptBonus - timePenalty));

    // --- VERİTABANINA YAZMA ---
    try {
        await admin.firestore().collection('scores').add({
            nickname: nickname.trim(),
            score: finalCalculatedScore, // Kendi hesapladığımız güvenilir skor
            accuracy: avgPercent,
            attempts: attemptsCount,
            time: finalTimeInSeconds,    // Kendi tuttuğumuz güvenilir süre
            date: date,
            mode: mode,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        return { 
            success: true, 
            score: finalCalculatedScore,
            time: finalTimeInSeconds 
        };
    } catch (error) {
        throw new functions.https.HttpsError('internal', 'Veritabanı hatası oluştu.');
    }
});