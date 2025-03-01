const authenticate = function (req, res, next) {
  const allowedAgent = process.env.ALLOWED_AGENT;
  if (req.header("User-Agent").includes(allowedAgent)) {
    next();
  } else {
    return res.status(200).json({ message: "Authentication failed." });
  }
};


module.exports = {
  authenticate,
};