const { ALLOWED_AGENT } = require("../constants");
const authenticate = function (req, res, next) {
  if (req.header("User-Agent").includes(ALLOWED_AGENT)) {
    next();
  } else {
    return res.status(200).json({ message: "Authentication failed." });
  }
};

module.exports = {
  authenticate,
};
