const args = require('yargs').argv;
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

const logError = (err) => {
    if (err) { 
        console.error(err);
    }
};

function generate(inFileRel, outFileRel, data){
    const template = fs.readFileSync(path.resolve(__dirname, inFileRel), 'utf-8');
    const content = ejs.render(template, data);
    fs.writeFileSync(path.resolve(__dirname, outFileRel), content, logError);
}

generate('config.prod.ejs', '../config.production.json', args);
generate('app.ejs', '../app.yaml', args);
