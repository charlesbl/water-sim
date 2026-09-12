# Climat en bouteille à deux couches

Branche expérimentale : `codex/two-layer-weather`.

Le terrain représente nominalement **10 × 10 km**, avec des contrastes initiaux d'environ **2 km**. Le solveur d'eau garde sa grille **2048²**, sa gravité et son amortissement. L'atmosphère utilise deux grilles **256²** : air bas en contact avec le sol, air haut portant les nuages.

## Frontière de la bouteille

Les parois sont imperméables pour l'air, l'eau et les sédiments. Il n'existe plus de mode périodique, de drainage vers l'extérieur, de pluie artificielle automatique ou de réservoir imposant l'humidité. Les températures et vents cibles, l'entraînement régional, le renouvellement procédural et la rotation prescrite sont supprimés.

Le soleil et le rayonnement infrarouge sont les seuls échanges énergétiques automatiques explicitement imposés à la frontière. La pluie provient de l'eau atmosphérique ; l'évaporation transfère l'eau disponible en débitant la chaleur de surface. L'ancien raccourci d'évaporation sans coût thermique disparaît. La lave ne fournit plus de chauffage permanent : son pinceau apporte une impulsion de chaleur finie lors de l'ajout, et son incandescence reste un effet visuel.

Les pinceaux, la génération du terrain, Clear fluids, Restart air et Reset weather modifient manuellement les stocks de la bouteille. Ce sont des interventions de l'utilisateur, hors du bilan radiatif.

## Panneau Energy à gauche

Le petit panneau repliable montre `IN → bouteille → OUT`, puis `IN − OUT` :

- **IN / Sun absorbed** : énergie solaire effectivement absorbée par la surface, après albédo, incidence et ombres des nuages. La lumière réfléchie n'est pas incluse dans cette entrée absorbée.
- **OUT / IR to space** : infrarouge qui s'échappe au sommet des deux couches. L'émission de surface réabsorbée par l'air est un transfert interne et n'est pas comptée comme une sortie.
- **IN − OUT** : flux radiatif net ; positif vers la bouteille, négatif vers l'extérieur.

Les valeurs sont des **uE par seconde météo**, dans les unités simplifiées du jeu, pas des watts. Accélérer l'horloge change la vitesse d'évolution ; cela ne change pas l'unité du panneau. Les flux viennent des calculs GPU utilisés par la simulation : une réduction intégrée à la passe de surface puis une réduction finale fournissent quatre nombres (entrée, sortie, différence, instant météo). Le panneau ouvert lit 16 octets au maximum une fois par seconde réelle ; fermé, il ne demande aucune lecture. En pause ou avec la météo désactivée, les échanges appliqués sont affichés à zéro. Son état ouvert/fermé est sauvegardé.

**Limite du bilan :** il mesure les échanges radiatifs à la frontière, pas l'énergie totale stockée dans tous les réservoirs. La nouvelle circulation transporte la chaleur par flux conservatifs et comptabilise le travail et la dissipation mécaniques. Les autres couplages et bornes numériques du modèle complet restent à auditer. Leur dérive devra être quantifiée séparément ; on ne peut pas déduire cette conservation des trois nombres affichés.

## Réglages

**Climate** sépare les conditions initiales des paramètres qui agissent pendant l'évolution. Température, humidité, stabilité, vitesse/direction du vent initial, taille des masses d'air, contrastes et graine ne s'appliquent qu'au redémarrage. Le vent initial vaut **0** par défaut. Un vent initial non nul est une impulsion finie dans la couche basse, dont la pression détermine le retour. Les vents des deux couches peuvent ensuite évoluer indépendamment. Les anciennes préférences régionales gardent les réglages compatibles du terrain, de l'eau, de l'interface et de la caméra ; le vent anciennement entretenu est réinitialisé au défaut calme.

Les échanges entre couches, le délai de maturation de la pluie, la réponse au relief et les paramètres radiatifs restent réglables. **Sun** rassemble le soleil, l'infrarouge et l'évaporation. Le sélecteur de vue et l'opacité commune restent dans la barre supérieure ; les réglages fins de rendu restent dans **Observe**.

**Restart air** préserve l'eau, la neige et la glace au sol mais remplace l'état de l'air. **Reset weather** réinitialise aussi neige et glace. Ces actions ouvrent un nouveau bilan d'eau ; elles ne prétendent pas conserver l'état précédent.

## Ce qui continue d'évoluer

L'eau circule entre vapeur, nuages, pluie/neige, eau liquide et couverts gelés. Le rayonnement, l'inertie thermique, l'albédo de la neige, les ombres des nuages et les changements de phase restent couplés. Le brouillard bas produit de la pluie plus lentement que les nuages hauts. Le relief et l'instabilité renforcent le mélange des deux couches. Les nuages reconstruits, précipitations et cartes suivent ces stocks ; les traceurs visuels ne traversent plus les murs pour réapparaître à l'autre bord.

Les pistes 1 et 2 de [la liste courte](pistes-instabilite.md) sont implémentées : circulation thermique fermée et chauffage différent des surfaces. Les pistes 3 et 4 complètent les changements de phase existants ; la piste 5 était déjà couplée au chauffage et partage désormais sa loi d'atténuation avec le rendu. Les pistes 6 à 9 restent à explorer.

## Circulation MAC à deux couches

Le cœur du vent a été remplacé : deux champs horizontaux indépendants et une vitesse verticale à l'interface, sur une grille MAC. Les courants transportent leur quantité de mouvement par flux conservatifs reconstruits avec MUSCL/minmod et deux étapes RK. Le champ transportant le mouvement reste celui de la dernière projection pendant ces étapes. Chaleur et quatre stocks d'eau suivent également un transport conservatif à deux étapes.

Une projection de pression commune aux deux couches équilibre la divergence dans les volumes de référence. Son solveur multigrille traite les grandes structures sur des grilles horizontales plus grossières, en conservant les deux inconnues verticales. Le retour haut exactement opposé et l'ancien calcul vertical immédiat sont supprimés. Les parois, le fond et le couvercle imposent un flux normal nul.

La flottabilité utilise les contrastes de température potentielle. Le travail reste payé depuis une réserve thermique finie ; frottement et pertes numériques ont des contreparties thermiques. Ce bilan simplifié chaleur/mouvement ne possède **pas de réservoir pronostique séparé d'énergie potentielle gravitationnelle**. Ce point reste une approximation du modèle, même si la dynamique du vent est désormais projetée. La conservation du système eau/air/sol complet n'est pas démontrée.

Le pinceau Wind injecte son impulsion dans la couche basse ; la projection et le transport déterminent sa propagation et les retours. Une limite de Courant commune multiplie tout le champ par le même facteur si nécessaire, préservant l'équilibre obtenu par la projection. Elle remplace l'ancien plafond appliqué indépendamment à chaque face. Le travail du pinceau reste une intervention manuelle hors du panneau radiatif.

**Limites :** la projection conserve les volumes à sa tolérance numérique ; sa précision est réglable. Deux niveaux donnent une structure verticale grossière. La géométrie mécanique est une boîte dans les coordonnées de référence : le relief intervient dans les échanges thermiques et le mélange orographique existant, sans résolution complète des faces inclinées du terrain. Coût GPU et comportement des averses restent à mesurer. Voir [la description du vent MAC](mac-wind.md).

## Chauffage du paysage et observation

Le soleil est absorbé localement selon l'incidence, l'albédo et les ombres. La capacité thermique existante de l'eau et des matériaux détermine la vitesse de variation de température. L'ancien réglage **Surface heating contrast** et sa redistribution globale de l'énergie solaire sont supprimés ; aucun bonus de chauffe des terres n'est ajouté.

**Climate → Thermal circulation** expose **Thermal expansion**, **Air friction**, **Air viscosity**, **Pressure quality** et **Surface–air heat exchange**, en plus du mélange entre couches. La friction vaut maintenant 0,006 /s par défaut près du sol et dix fois moins en altitude ; la viscosité vaut 0,005 et la pression utilise trois cycles multigrilles. L’ancienne friction par défaut est migrée ; les valeurs modifiées sont conservées. Le dernier règle les échanges thermiques appariés, sans changer l'inertie de l'eau ni son solveur d'écoulement. La vue **Updrafts & downdrafts** représente l'interface en bleu (descente), sombre (calme) et ambre (montée). Les traceurs de vent utilisent aussi la composante verticale ; les nuages et précipitations gardent leur rendu.

## Changements de phase et rétroactions humides : pistes 3, 4 et 5

La condensation était déjà chauffante. Elle est maintenant ajustée par deux demi-étapes, avant le calcul des pressions et après le transport : l'énergie libérée peut donc modifier immédiatement la circulation thermique. **Climate → Cloud adjustment** règle la vitesse des échanges vapeur/nuage, par défaut **2 /s** ; zéro suspend ces échanges. Ce réglage change leur délai, jamais l'énergie rendue par unité d'eau.

Le coût latent est désormais le même à la surface et dans l'air : **480 uE par unité d'eau**. L'ancien écart 450/480 est supprimé. La chaleur sensible emportée par l'évaporation accompagne la vapeur en attente puis rejoint l'air ; réciproquement, la chaleur déposée avec pluie/neige est débitée de l'air et répartie avec les mêmes poids que l'eau. La formation de neige libère les **80 uE** que sa fonte consomme. L'évaporation est également limitée par la chaleur disponible au-dessus du plancher thermique.

Cette comptabilité garde la capacité calorifique de référence de l'air égale à un : la chaleur sensible des phases aériennes est regroupée dans celle de l'air. Le réservoir sensible en attente réutilise le tampon fin des échanges thermiques après sa réduction ; ce couplage latent n'ajoute aucune grille fine permanente. Le nouveau solveur de vent ajoute ses propres passes et tampons à la résolution atmosphérique. Le dépôt grossier passe de deux à quatre nombres par colonne pour transporter aussi la chaleur.

La pluie tombant de la couche haute traverse l'ajustement évaporatif de la couche basse **avant** son dépôt au sol. **Climate → Rain evaporation**, par défaut **0,40 /s** au lieu de l'ancien coefficient fixe 0,08 /s, règle cette vitesse ; zéro la suspend. L'eau réellement présente et la saturation après refroidissement limitent le transfert. La poche froide agit sur la pression et s'étale par la circulation existante. Il n'y a ni rafale prescrite, ni recharge de froid, ni déplacement artificiel des averses. Leur renouvellement durable et d'éventuelles ascendances périphériques restent à observer en jeu.

**Sun → Cloud sun shielding** reste l'unique réglage des ombres. Les nuages retirent une partie du soleil absorbé localement ; aucune source de refroidissement supplémentaire n'est créée. Surface et rendu utilisent la même densité interpolée et la même loi d'atténuation. L'ombre est représentée plus légèrement pour garder le terrain lisible. L'opacité visuelle des nuages n'affecte pas leur effet thermique. La projection reste verticale sous la colonne : l'altitude et les détails artistiques des nuages ne déplacent pas le chauffage.

Ces échanges internes n'apparaissent pas comme IN ou OUT dans le panneau radiatif. Le bilan global incluant l'écoulement de l'eau, les changements du relief et les bornes de température reste distinct et non validé.

## État de validation

Vérifications minimales réussies le 12 septembre 2026 : **TypeScript, build et quatre suites ciblées (47 assertions)**. Aucun aperçu visuel ni benchmark effectué. Les anciennes suites `regional-*` contiennent encore des attentes liées au forçage et aux contrôles supprimés ; elles devront être adaptées avant une validation plus large. Les précédents résultats de la version régionale ne valident pas cette révision.

La prochaine validation devra couvrir les parois, l'absence de forçage et de sources d'eau externes, les échanges radiatifs (soleil nul, infrarouge nul, nuages, pause, redémarrage), le panneau et les préférences, puis les régressions eau/neige/glace/sédiments. La suite dédiée `bottle-circulation` est préparée pour vérifier le départ depuis le repos, les retours, les transferts verticaux, le bilan mécanique/thermique et une séparation terre/eau. Elle n'a pas été exécutée. La conservation énergétique globale et la dynamique durable des averses restent à valider séparément.

La nouvelle suite `bottle-feedbacks` prépare des comparaisons avec/sans condensation, avec/sans évaporation de pluie, l'arrivée de pluie dans l'air bas, la circulation d'une poche froide, les bilans eau/chaleur sensible/latente/cinétique avec les stocks en attente, la formation de neige et l'atténuation solaire par les nuages. Elle appelle les passes de production et **n'a pas été lancée**. Les nouveaux contrôles, leurs resets individuels et le rendu restent à vérifier dans l'interface.

Principes de référence : [brise et courant de retour — NOAA](https://inside.nssl.noaa.gov/ensmith/metr5603/intro-overview/), [pression sous couvercle rigide — MITgcm](https://mitgcm.org/public/r2_manual/latest/online_documents/node33.html). Le mode réduit décrit ici est une approximation propre au jeu.

Les suites `mac-pressure` et `mac-momentum` ont réussi : suppression d'un gradient de pression connu à 32² et 256², préservation d'un tourbillon commun aux deux couches, déplacement d'une paire de tourbillons sans source thermique, divergence et bilan chaleur/mouvement de ce cas isolé. `wind-brush` a réussi pour la réponse hors du cercle, les parois et le plafond de Courant commun. `mac-wind-ui` a réussi pour les contrôles du vent, leurs resets et les migrations de préférences. Le point d'entrée WGSL réservé `smooth` a été renommé `relaxPressure` pour corriger une erreur de compilation détectée par ces tests.
