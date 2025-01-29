const Zkteco = require("zkteco-js");
const { IP } = require("./constants");

const manageZktecoDevice = async () => {
    const device = new Zkteco(IP, 4370, 5200, 5000);

    try {
        // Create socket connection to the device
        await device.createSocket();

        await device.enableDevice();
        // Listen for real-time logs
        await device.getRealTimeLogs((realTimeLog) => {
            console.log(realTimeLog);
        });

        // Manually disconnect after using real-time logs
        // await device.disconnect();
    } catch (error) {
        console.error("Error:", error);
    }
};

manageZktecoDevice();