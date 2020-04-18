const args = require('yargs').argv;
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

const logError = (err) => {
    if (err) { 
        console.error(err);
    }
};

function buildGhostProdConfig() {
    const template = fs.readFileSync(path.resolve(__dirname, 'config.prod.ejs'), 'utf-8');
    const content = ejs.render(template, args);
    fs.writeFileSync(path.resolve(__dirname, '../', 'config.production.json'), content, logError);
}

buildGhostProdConfig();
