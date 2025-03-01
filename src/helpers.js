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
  
  const getStateById = (stateId) => {

    let state = 'clock-in';
    switch (parseInt(stateId, 10)) {
        case 0:
            state = 'check-in';
            break;
        case 1:
            state = 'check-out';
            break;
        case 2:
            state = 'break-in';
            break;
        case 3:
            state = 'break-out';
            break;
        case 4:
            state = 'overtime-in';
            break;
        case 5:
            state = 'overtime-out';
            break;
    }

    return state;
};
  
  module.exports = {
    getConfig,
    getStateById
  };