export const schema = Object.freeze({
  "product": "展会报名同步台",
  "entity": "报名记录",
  "identity": "sourceId",
  "required": [
    "sourceId",
    "source",
    "observedAt",
    "label"
  ],
  "description": "展会报名台的重复录入防护"
});
