const child_process = require('child_process');
function unsafe(input) {
    eval(input);
    new Function(input)();
    child_process.exec(input);
}
