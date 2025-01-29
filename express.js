const express = require('express');
const getRawBody = require('raw-body')
const app = express();
const port = 3016;
const moment = require('moment-timezone');
moment().tz("Asia/Dhaka").format();
const NodeCache = require( "node-cache" );
let myCache = new NodeCache();


app.use(function (req, res, next) {
    getRawBody(req, {
        length: req.headers['content-length'],
        limit: '1mb',
        encoding: 'utf8'
    }, function (err, string) {
        if (err) return next(err)
        req.text = string
        next()
    })
});

app.get('/', async (req, res) => {
    return res.status(200).json({message: 'MS of ADMS API'});
});


const authenticate = function (req, res, next) {
    const allowedAgent = process.env.ALLOWED_AGENT;
    if (req.header('User-Agent').includes(allowedAgent)) {
        next()
    } else {
        return res.status(200).json({ message: 'Authentication failed.' });
    }
};

// app.use(authenticate);


app.use(function (error, req, res, next) {
    //Catch json error
    return res.status(200).json({message: 'Problem Loading api'});
});

app.get('/iclock/cdata', async (req, res) => {
    res.set('Content-Type', 'text/plain');
    res.set('Date', new Date().toUTCString());
    const timestamp = +new Date();
    let configuration = `
GET OPTION FROM: ${req.query.SN}
ATTLOGStamp=9999
Realtime=1
Delay=60000
TransInterval=2
TransFlag=1000000000
TimeZone=6
Encrypt=0
`;
    res.send(configuration);
});

app.get('/iclock/getrequest', async (req, res) => {
    res.set('Content-Type', 'text/plain');
    res.set('Date', new Date().toUTCString());

    let startTime = moment().subtract(5, 'minutes').format('YYYY-MM-DD hh:mm:ss')
    res.send(`C:${Math.floor(Math.random() * 1000)}:DATA QUERY ATTLOG StartTime=${startTime}`);
});

app.post('/iclock/cdata', async (req, res) => {
    res.set('Content-Type', 'text/plain');
    res.set('Date', new Date().toUTCString());
    let attendances = req.text;
    let attendanceLines = attendances.split('\n');


    attendanceLines.map((line) => {
        if (line.length) {
            let attendance = line.split('\t');
            let userId = attendance[0];
            let activityTime = attendance[1];
            let stateId = attendance[2];

            console.log(req.query.SN, attendances, {
                pin: userId,
                activityTime: activityTime,
                lineRaw: line,
                stateId: stateId
            });

        }
    });
    res.send("OK:" + (attendanceLines.length - 1));
});

app.post('/iclock/devicecmd', async (req, res) => {
    let shouldBeOkay = moment().minute() % 10 == 0;
    if (shouldBeOkay) {
        res.send("OK");
    }
});

app.listen(port, () => console.log(`PMS-MS-SMS service listening on port ${port}!`))