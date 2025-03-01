const getConfig = (req, offsetHours) => {
    return `
  GET OPTION FROM: ${req.query.SN}
  ATTLOGStamp=9999
  Realtime=1
  Delay=60000
  TransInterval=2
  TransFlag=1000000000
  TimeZone=${offsetHours}
  Encrypt=0
  `;
  };
  
  
  module.exports = {
    getConfig,
  };