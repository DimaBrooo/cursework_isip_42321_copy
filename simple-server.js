const path = require("path");
const express = require("express");
const http = require("http");

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);

app.use(express.static(path.join(__dirname)));

// Перенаправление с корня сайта на menu.html
app.get("/", (_req, res) => {
    res.redirect("/menu.html");
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server started on http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT} to access the site`);
});
