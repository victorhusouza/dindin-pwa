// Capitaliza a primeira letra da descricao ("uber" -> "Uber").
// Nao mexe quando a 2a letra ja e maiuscula (iFood, eBay) nem quando
// a string nao comeca com letra ("99 taxi"). Unicode: "agua" -> "Agua".
export function capFirst(s: string): string {
    if (!s) return s;
    const first = s[0];
    if (first.toLowerCase() !== first || first.toUpperCase() === first) return s; // nao e letra minuscula
    if (s.length > 1) {
        const second = s[1];
        if (second.toUpperCase() === second && second.toLowerCase() !== second) return s; // marca com minuscula proposital
    }
    return first.toUpperCase() + s.slice(1);
}
