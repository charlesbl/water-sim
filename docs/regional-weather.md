# Météo régionale à deux couches

Branche expérimentale : `codex/two-layer-weather`.

Le terrain représente environ **10 × 10 km**, avec des masses d'air d'environ **2 km** et une évolution visible sur **1 à 3 minutes de jeu**. Les kilomètres servent à régler la météo et son rendu ; ils ne redimensionnent pas le solveur d'eau. Celui-ci conserve sa grille **2048²**, sa gravité, son amortissement, ses échanges de sédiments et ses valeurs par défaut.

## Ce qui est simulé

Deux grilles **256²**, soit 131 072 cellules, remplacent le volume 96 × 96 × 64. La couche basse échange avec le sol ; la couche haute porte les nuages. Chaque cellule contient vent horizontal, anomalie de pression, température, vapeur, eau nuageuse, pluie et neige en suspension.

Les flux d'eau entre voisins partagent la même valeur de part et d'autre d'une face et sont limités par le stock du donneur. Les échanges verticaux et les changements de phase débitent un réservoir et créditent l'autre. Le dépôt au sol est interpolé et normalisé par les surfaces : une pluie lissée conserve son volume même si les deux résolutions ne sont pas divisibles. La vapeur issue de l'évaporation et de la lave passe par un stock en attente, inclus dans le bilan.

La pression se propage par une approximation d'ondes amorties, sans projection 3D itérative. La rotation du vent et une réponse tangentielle aux contrastes thermiques représentent la circulation régionale non résolue. L'ascension devant le relief refroidit l'air ; la descente le réchauffe. L'instabilité et le relief renforcent les échanges entre couches.

La température de la surface conserve les échanges thermiques, le rayonnement, l'inertie de l'eau, la fonte, le gel et l'albédo de la neige. L'eau nuageuse réduit maintenant aussi l'ensoleillement reçu. Le réglage d'évaporation donne un temps de séchage d'environ trois minutes à un film d'eau avec les valeurs par défaut, afin que la pluie puisse rejoindre les écoulements. Ce temps dépend aussi du déficit de saturation et de l'eau disponible.

## Éviter une météo qui se fige

Le premier prototype laissait simplement évoluer des contrastes initiaux. Ils se dissipaient, puis la pluie se concentrait au-dessus des plans d'eau. Une petite région isolée ne renouvelle pas spontanément les systèmes météorologiques du monde extérieur.

**Regional energy**, activé par défaut, entretient donc un vent régional et un environnement thermique large qui évoluent lentement. **Regional evolution time** règle leur rythme, par défaut 180 secondes météo. C'est un apport extérieur d'énergie et de quantité de mouvement, pas une simulation fermée de toute l'atmosphère terrestre. Sa forme est procédurale et déterministe ; les lieux de pluie ne sont pas prescrits. Ils résultent du transport de l'eau, de la saturation, du relief et des échanges avec la surface.

La couche basse transforme ses nuages en pluie cinq fois moins vite que la couche haute. Cela distingue le brouillard de surface d'un nuage pluvieux et laisse davantage de temps à l'eau évaporée pour gagner l'intérieur des terres.

Mettre **Regional energy** à 0 permet de retrouver l'expérience d'une atmosphère isolée. Ses contrastes et son vent peuvent s'atténuer avec le temps. **Wind turning** règle la courbure des flux ; **Thermal circulation** leur réponse aux gradients de température. L'énergie régionale n'ajoute jamais d'eau, y compris avec les bords atmosphériques fermés.

## Réglages pour jouer

| Réglage                 | Défaut   | Effet                                                                                |
| ----------------------- | -------- | ------------------------------------------------------------------------------------ |
| Landscape scale         | 10 km    | Échelle nominale et conversion de la vitesse du vent ; géométrie visuelle des nuages |
| Air-mass size           | 2 km     | Taille des contrastes initiaux et de l'environnement thermique régional              |
| Regional energy         | 1×       | Entretien de la circulation ; 0 = atmosphère isolée                                  |
| Regional evolution time | 180 s    | Rythme des changements régionaux                                                     |
| Regional wind speed     | 2 km/min | Vent de référence ; le vent réel est perturbé par la simulation                      |
| Cloud-to-rain time      | 60 s     | Délai de maturation ; l'allonger favorise le transport avant pluie                   |
| Mountain influence      | 1,5×     | Refroidissement et échanges liés au relief                                           |
| Air-mass contrasts      | 0,8×     | Amplitude des contrastes thermiques et de l'humidité initiale                        |
| Upper wind difference   | 35 %     | Écart de direction et de vitesse entre les deux couches                              |
| Wind turning            | 1×       | Courbure et circulation autour des contrastes thermiques                             |
| Layer mixing            | 0,008/s  | Mélange de fond ; l'instabilité ajoute du brassage                                   |
| Weather speed           | 1×       | Accélère seulement l'horloge météo                                                   |

Les libellés **Initial conditions** demandent **Restart air**. Ceux **Initial + regional drive** déterminent l'initialisation et l'environnement régional quand son énergie est activée. La température et le vent sont des références régionales dans ce mode. Avec l'énergie à 0, ils ne s'appliquent qu'au redémarrage de l'air. L'humidité initiale n'est jamais entretenue dans le cycle fermé.

Les presets Mild, Snow, Thaw, Storm et Dry redémarrent l'air et conservent l'eau, la neige et la glace au sol. Un redémarrage remplace le stock d'eau atmosphérique : il établit donc un nouveau bilan. **Reset weather** efface aussi neige et glace. Les réglages sont sauvegardés ; les anciennes unités du modèle 3D sont migrées vers les nouveaux défauts, en conservant les préférences du terrain, de l'eau et de la caméra.

## Rendu et observation

Les nuages sont reconstruits visuellement en volume à partir de l'eau condensée dans les deux couches. Un bruit de détail module leur forme, sans modifier l'eau simulée. La couche basse produit des bancs de brouillard ; la haute produit des nuages plus épais. Rideaux de pluie, gouttes, flocons, ombres et assombrissement après pluie suivent les champs météo.

**Observe** propose les nuages, les cartes de température/humidité/vent par couche, le radar de pluie/neige et la pluie récente. **Recent wetness** est une mémoire des précipitations qui décroît en trois minutes, pas une humidité de sol ou une sécheresse agronomique. La nappe phréatique et la végétation ne sont pas simulées.

La hauteur, l'épaisseur, le détail et l'opacité des nuages sont indépendants des réserves d'eau. La profondeur de référence de 32 unités, divisée en deux couches, sert aux bilans ; elle ne doit pas être remplacée par la hauteur choisie pour le rendu.

## Scénarios d'essai

1. **Météo durable** : partir de Mild, ajouter un grand lac, activer le radar et observer plusieurs minutes. Régler Weather speed à 4 pour accélérer. Comparer Regional energy à 1 puis à 0, sans redémarrer l'air.
2. **Transport vers les terres** : vent de référence dirigé depuis la mer, Cloud-to-rain time entre 60 et 100 s. Le radar permet de distinguer la pluie de la simple couverture nuageuse.
3. **Relief** : placer ou lever une montagne sous le vent et comparer Mountain influence à 0 puis 2. L'air ascendant doit se refroidir et échanger davantage avec la couche haute.
4. **Neige et fonte** : appliquer Snow, laisser se former la neige et la glace, puis Thaw. Le sol est préservé, la fonte alimente la même eau liquide que les rivières.
5. **Réactivité** : réduire Regional evolution time à 90 s ou augmenter Weather speed. Allonger le temps régional à 300 s pour des systèmes plus persistants.

## Validation

Avec Vite actif : `npm run test:weather`. Les suites utilisent les vrais shaders WebGPU dans un profil Chrome isolé.

- Le test atmosphérique complet mesure les régions humides/sèches, les budgets ouverts par redémarrage puis fermés durant l'évolution, les bords périodiques/fermés, le gel et la fonte.
- Son scénario de mer est initialement sans vapeur : après onze minutes, il exige encore de la pluie au moins 2 km à l'intérieur des terres et un changement du vent et des précipitations sur la dernière minute. Il ne dépend donc pas de l'averse initiale d'un preset.
- L'intégration teste séparément le terrain/eau **2048²**, les deux couches **256²**, le bilan CPU/GPU et les six modes de rendu.
- Les suites neige/glace et sédiments vérifient les échanges de masse, la fonte, les écoulements et l'érosion conservés. La suite UI vérifie limites, recherche, presets, couches et sauvegarde.

Le transport d'eau est conservatif à la précision flottante. Les échanges thermiques locaux conservent leurs débits/crédits, mais le modèle complet n'est pas un système d'énergie fermé : soleil, infrarouge, lave et entraînement régional en échangent. Les temps et la rotation sont réglés pour le jeu. Ce modèle ne résout ni profil vertical fin, ni convection 3D, ni véritable dynamique synoptique. Le coût atmosphérique est structurellement réduit ; aucun facteur de gain FPS n'est annoncé sans benchmark comparatif.
