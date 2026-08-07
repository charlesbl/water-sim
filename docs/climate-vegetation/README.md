# Plan d'implémentation — climat, cycle de l'eau et végétation

Ce dossier décrit une évolution progressive de TerraGPU vers une simulation
environnementale émergente. Chaque étape possède son propre fichier, ses
dépendances, ses changements de données, ses tests et ses critères de sortie.

L'objectif n'est pas de reproduire une atmosphère scientifique en trois
dimensions. L'objectif est un modèle 2.5D cohérent et lisible, capable de faire
émerger des lignes de neige, des zones humides, des ombres pluviométriques, des
sécheresses, de la végétation riveraine et des transitions climatiques sans
programmer une succession d'événements météo.

## Principes non négociables

1. **Conservation mesurée** : l'eau ne disparaît plus lors de l'évaporation.
   Elle change de réservoir entre eau liquide, eau solide, sol, vapeur et
   nuages. Les seules entrées/sorties sont explicitement identifiées.
2. **Pas de météo scénarisée** : le soleil, la dissipation, les conditions aux
   limites et les lois locales sont paramétrés ; la position des pluies et des
   zones chaudes ne l'est pas.
3. **Plusieurs échelles** : l'eau et le sable restent à pleine résolution.
   L'atmosphère et l'écologie utilisent des grilles plus petites et des
   fréquences de mise à jour plus lentes.
4. **Déterminisme** : à seed, paramètres et séquence d'entrées identiques, le
   résultat GPU doit être reproductible sur une même pile matérielle.
5. **Observabilité avant réglage** : toute nouvelle quantité physique dispose
   d'une vue de diagnostic et, si elle est conservée, d'un compteur global.
6. **Compatibilité progressive** : tant que le nouveau cycle hydrologique
   n'est pas validé, l'ancien mode pluie/évaporation reste accessible derrière
   un mode de compatibilité.

## Architecture cible

### Échelles par défaut

| Domaine                 | Résolution pour un terrain 2048² |      Cadence indicative |
| ----------------------- | -------------------------------: | ----------------------: |
| Eau, lave, sable, glace |                            2048² |    chaque tick physique |
| Atmosphère              |                   256² (`N / 8`) |   tous les 8 à 32 ticks |
| Sol et végétation       |                   512² (`N / 4`) | tous les 32 à 128 ticks |

Les cadences sont pilotées par le temps simulé et non par le nombre d'images
affichées. Elles devront rester configurables pour les petites grilles de test.

### Contrats de données cibles

Les noms exacts pourront évoluer durant l'implémentation, mais leur sémantique
doit être figée dès l'étape 01.

```wgsl
struct TerrainCell {
    rock: f32,
    sand: f32,
    suspended_sand: f32,
    avalanche: f32,
}

struct FluidCell {
    water: f32,                // hauteur d'eau liquide
    lava: f32,                 // hauteur de lave
    solid_water: f32,          // glace ou neige, en équivalent eau
    surface_temperature: f32,  // degrés Celsius
}

struct AtmosphereThermoCell {
    air_temperature: f32,      // degrés Celsius
    vapor: f32,                // équivalent eau par aire
    cloud_water: f32,          // eau condensée
    precipitation_rate: f32,   // diagnostic/source vers la surface
}

struct AtmosphereDynamicsCell {
    wind_x: f32,
    wind_y: f32,
    pressure: f32,
    vertical_lift: f32,
}

struct EcologyCell {
    soil_moisture: f32,
    biomass: f32,
    fertility: f32,
    litter: f32,
}
```

`steam` disparaît à terme de `FluidCell`. La vapeur atmosphérique devient un
véritable réservoir dans `AtmosphereThermoCell`. La vapeur visible près de la
lave sera dérivée de la chaleur de surface, de l'eau locale et de l'humidité.

### Échanges entre grilles

- Un shader de **résumé de surface** rassemble, sans atomiques flottantes, les
  valeurs fines nécessaires à chaque cellule atmosphérique : hauteur moyenne
  et maximale, température, couverture en eau/glace, biomasse, humidité du sol
  et rugosité.
- Chaque invocation atmosphérique lit le bloc de cellules fines qui lui
  correspond. Avec un diviseur 8, elle effectue au maximum 64 lectures par
  champ utile ; le coût total reste de l'ordre d'une lecture de la grille fine.
- Les précipitations et la température atmosphérique sont rééchantillonnées
  vers la surface. Les conversions utilisent des unités « par aire » afin de
  conserver la masse malgré la différence de résolution.
- La grille écologique rassemble de la même façon les informations de son bloc
  de terrain, puis échantillonne l'atmosphère par interpolation bilinéaire.

### Ordre logique d'un cycle

1. Accumuler le temps physique fixe.
2. Exécuter les ticks hydrauliques nécessaires.
3. À échéance écologique, résumer la surface, mettre à jour sol et végétation,
   puis appliquer à la grille fine les budgets d'infiltration ou de restitution
   calculés sur la grille écologique.
4. À échéance climatique, reconstruire le résumé de surface, mettre à jour
   dynamique atmosphérique, transport, condensation et précipitations.
5. Appliquer dans une passe fine unique les budgets conservatifs d'évaporation,
   pluie et neige produits par l'atmosphère. Cette passe fait basculer le
   ping-pong des fluides comme n'importe quel tick de surface.
6. Appliquer, si nécessaire, le budget d'évapotranspiration au buffer
   écologique sans réexécuter sa croissance.
7. Rendre le dernier état complet, sans interpolation d'un buffer en cours
   d'écriture.

Les échanges sont calculés depuis un snapshot qui ne change pas entre le résumé
et leur application. Les quantités atmosphériques et les quantités retirées ou
ajoutées à la surface sont donc les deux côtés d'un même budget, sans atomiques
et sans dépendance circulaire dans une passe GPU.

## Budget mémoire cible

Pour un terrain 2048², avec atmosphère 256² et écologie 512² :

- paire `AtmosphereThermoCell` : environ 2 Mio ;
- paire `AtmosphereDynamicsCell` : environ 2 Mio ;
- paire `EcologyCell` : environ 8 Mio ;
- résumé de surface atmosphérique de huit flottants : environ 2 Mio ;
- buffers de réduction et readback : moins de 2 Mio.

La cible est donc **moins de 16 Mio permanents supplémentaires**. L'eau solide
et la température de surface réutilisent les deux composantes actuellement
occupées par `temp` et `steam`, ce qui évite une paire pleine résolution de
128 Mio.

## Séquence d'implémentation

1. [Socle, horloge et contrats GPU](./01-socle-horloge-contrats.md)
2. [Température de surface et gradient d'altitude](./02-temperature-surface.md)
3. [Gel, glace, neige et fonte](./03-cryosphere.md)
4. [Cycle hydrologique atmosphérique](./04-cycle-hydrologique.md)
5. [Vent et météo spatiale](./05-vent-meteo.md)
6. [Sol et végétation réactive](./06-sol-vegetation.md)
7. [Rétroactions climat–végétation–terrain](./07-retroactions.md)
8. [Rendu, interface et outils de diagnostic](./08-rendu-interface.md)
9. [Validation, performances et équilibrage](./09-validation-performance.md)
10. [Intégration, migration et livraison](./10-integration-livraison.md)

## Définition globale de réussite

La feuille de route est terminée lorsque les scénarios suivants apparaissent
sans script événementiel :

- une ligne de neige dépendante de l'altitude et de l'exposition ;
- un lac qui gèle depuis ses zones les plus froides puis dégèle ;
- de l'eau qui s'évapore, voyage, condense et revient en précipitation ;
- une montagne qui crée un versant humide et un versant sous le vent plus sec ;
- une végétation dense près de l'eau et rare dans les zones froides, sèches,
  inondées ou volcaniques ;
- une modification mesurable du microclimat et de l'érosion par la végétation ;
- un bilan hydrique expliqué et borné sur un test long ;
- un coût GPU compatible avec le budget défini à l'étape 09.
