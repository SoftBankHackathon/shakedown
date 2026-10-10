export function parseTitle(input) {
    const data = JSON.parse(input);
    return String(data.title).trim();
}
