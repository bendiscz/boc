# Projekt BoC

Toto jsou základní instrukce pro vytvoření terminálové aplikace _Bot of Code_,
zkráceně _BoC_, která bude autonomně řešit úlohy
z [Advent of Code](https://adventofcode.com).

## Požadavky

- Aplikace se po spuštění bude chovat jako soutěžící programátor – bude čekat
  na novou úlohu a jakmile bude úloha zpřístupněna, pokusí se ji co
  nejrychleji vyřešit.
- Aplikace bude ukládat detailní průběh i výsledky řešení všech úloh na
  souborový systém v přehledné, snadno čitelné a navigovatelné formě.
- Aplikace poběží v terminálu a bude mít jednoduché TUI, které bude zobrazovat
  aktuální stav řešení úlohy.
- Aplikace bude napsaná v TypeScriptu, poběží v Node.js a bude postavená nad
  [Pi Agent Harness](https://github.com/earendil-works/pi).
- Aplikace bude s webem AoC komunikovat (stahovat zadání, odesílat výsledky)
  pomocí externě dodané session cookie.
- Pro řešení úloh bude mít k dispozici buď Github Enterprise Copilot
  subskripci nebo ChatGPT Business subskripci, a bude umět s těmito LLM
  poskytovateli komunikovat.
- Na řešení úloh může používat následující toolchainy: Python (`uv`), Node.js,
  Go a Rust, které budou již nainstalované v prostředí, kde běží.
- Aplikace musí přijít s vlastním řešením, **nesmí** kopírovat dostupná řešení
  z Internetu, ani se jimi inspirovat.
- Aplikace může pro vyřešení úlohy použít jakékoliv volně dostupné knihovny a
  algoritmy.
- Aplikace bude vědět, jaký budget má k dispozici, a nebude ho smět překročit.
- Aplikace bude plně v angličtině.

## Agentní vývoj 

Vývoj aplikace bude plně probíhat v tomto Pi coding agentovi, s naprosto
minimálními zásahy uživatele.
Vývoj nemusí probíhat pouze v jedné session, proto je potřeba spolu s kódem
ukládat i veškeré potřebné kontextové informace (plány, todo listy, rozhodnutí
atp.).
Pi s novou prázdnou session musí být schopen bez problémů navázat tam, kde
předchozí session skončila, pouhým promptem “go on”.

Vývoj bude probíhat maximálně autonomně, proto je potřeba, aby sis
inteligentně spravoval svůj kontext a plánoval další kroky.
Plně využil možností Pi agenta a nainstalovaných extensions
(např. pi-subagents).

Průběh vývoje commituj a pushuj do Gitu. Commity by měly být co nejvíce
srozumitelné a popisovat, co se v daném commitu změnilo.
Využij možností Gitu dle svého uvážení.

Secrets jako tokeny, AoC session cookie a další citlivé údaje bude aplikace
načítat ze souborů – ty se ale **nikdy** nesmí commitovat do Gitu.
Pokud budou soubory se secrets někde ve stromu tohoto projektu,
musí být přidány do `.gitignore`.

## Tvůj úkol 

Tvůj úkol je vytvořit aplikaci dle výše uvedených požadavků.
Budeš mít k dispozici nový AoC účet – využij úlohy z minulých let pro
testování a zdokonalování funkčnosti aplikace.
Tvůj výtvor pak použiju na řešení AoC úloh pro rok 2026 a budu proti němu
soutěžit, tak se snaž!

Používej výhradně angličtinu, tento soubor je první a poslední český text
v tomto projektu.

Hodně štěstí a těším se na tvé výsledky!

## Další kroky 

1. Pečlivě prozkoumej toto zadání a zvaž, zda je možné ho takto splnit.
   Pokud ti něco chybí, nebo považuješ některé požadavky za nesplnitelné,
   napiš to včetně důvodů a vysvětlení a skonči.
2. Vytvoř první commit, který bude obsahovat základní kontext pro nastartování
   vývoje aplikace (např. AGENTS.md, README.md – to nechám plně na tobě).
   Tento soubor smaž, zůstane pouze v historii Gitu.
3. Commit pushni do repozitáře a napiš mi, že je vše připraveno k zahájení
   vývoje.
