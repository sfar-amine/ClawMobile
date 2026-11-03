---
name: weather
description: Météo actuelle et prévisions (pluie, température, vent) pour une ville ou des coordonnées, via Open-Meteo et web_fetch.
---

# Météo

Utilise `web_fetch` sur Open-Meteo (gratuit, sans clé, joignable depuis le S24). wttr.in
n'est pas joignable depuis le S24 : ne l'essaie pas. Pas de `exec`/`curl` ni de
`web_search` pour la météo.

## 1. Lieu → coordonnées

Si la demande ne donne pas de lieu, prends le lieu habituel d'Amine s'il est connu par
le contexte ou la mémoire ; sinon demande la ville.

```javascript
await web_fetch({
  url: "https://geocoding-api.open-meteo.com/v1/search?name=La%20Marsa&count=1&language=fr&format=json",
  extractMode: "text", maxChars: 4000,
});
```

Prends `results[0].latitude`, `longitude`, `name`, `country`. Aucun résultat : demande
de préciser le lieu.

## 2. Prévision

```javascript
await web_fetch({
  url: "https://api.open-meteo.com/v1/forecast?latitude=36.88&longitude=10.32" +
    "&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&timezone=auto&forecast_days=3",
  extractMode: "text", maxChars: 8000,
});
```

- `current` : température, ressenti, pluie (mm), vent (km/h), `weather_code`.
- `daily` : une valeur par jour (aujourd'hui, demain, après-demain) : min/max,
  probabilité de pluie max (%), `weather_code`. Pour plus loin, `forecast_days` jusqu'à 16.
- Heure par heure seulement si on la demande : `&hourly=temperature_2m,precipitation_probability`
  avec `forecast_days` réduit.

Codes WMO (`weather_code`) : 0 ciel clair ; 1-3 peu à très nuageux ; 45, 48 brouillard ;
51-57 bruine ; 61-67 pluie ; 71-77 neige ; 80-82 averses ; 95-99 orage.

## Réponse

Une à trois phrases dans la langue de la demande : lieu, état, température (et ressenti
si l'écart dépasse 2 °C), pluie, vent si notable. Si Open-Meteo échoue, dis-le
simplement (service météo injoignable) sans essayer d'autres outils.
