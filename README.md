# entsoe-js
This is external module for openHAB automation.
This module allow:

* getSpotPrices;
* getAveragePrice;
* fillEmptyHours;

The function *fillEmptyHours* need because Entsoe sometime may return less 24 item "time"/price per 1 day (in case Period -> resolution = PT60M)

To allow work this module need *xml2json.xsl* file, which need put into /etc/openhab/transform
The original file possible download [here](https://xml2json.duttke.de/) (Last visited 2025-01)