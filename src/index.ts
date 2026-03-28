import { startGateway } from "./gateway.js";

const port = parseInt(process.env.PORT ?? "3742", 10);
startGateway(port);
