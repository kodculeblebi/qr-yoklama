const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// public klasörü oluşturulacak ve QR burada tutulacak
app.use(express.static('public'));

app.get('/', (req, res) => {
    const dersKodu = 'DERS101';
    const qrPath = path.join(__dirname, 'public', 'qr.png');

    QRCode.toFile(qrPath, dersKodu, { width: 300 }, (err) => {
        if(err){
            console.log(err);
            res.send('QR kod oluşturulamadı!');
        } else {
            res.send(`
                <h1>Merhaba, QR çalışıyor!</h1>
                <img src="/qr.png" alt="QR Kod"/>
            `);
        }
    });
});

app.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
