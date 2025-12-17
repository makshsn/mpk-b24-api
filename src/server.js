const app = require('./app');
const { PORT } = require('./config/env');
const { logger } = require('./middlewares/requestLogger');

app.listen(PORT, () => logger.info({ PORT }, 'Server started'));
