export function parseTitle(input: string): string {
    const data: { title: string } = JSON.parse(input);
    return data.title.trim();
}
