import * as child_process from 'child_process';
function unsafe(input: string): void {
    eval(input);
    new Function(input)();
    child_process.exec(input);
}
