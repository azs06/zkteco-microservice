const ZKLib = require("node-zklib");
const { IP } = require("./constants");

const test = async () => {
  let zkInstance = new ZKLib(IP, 4370, 10000, 4000);
  try {
    // Create socket to machine
    await zkInstance.createSocket();
    console.log("Socket created");

    // Get general info like logCapacity, user counts, logs count
    // It's really useful to check the status of device
    //console.log(await zkInstance.getInfo());
  } catch (e) {
    console.log(e);
    if (e.code === "EADDRINUSE") {
    }
  }

  await zkInstance.enableDevice();
  await zkInstance.getRealTimeLogs((data) => {
    console.log("logging")
    // do something when some checkin
    console.log(data);
  });

};

test();
