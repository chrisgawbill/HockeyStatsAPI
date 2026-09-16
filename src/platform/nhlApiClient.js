var axios = require('axios');

var axiosNhl = axios.create({
  baseURL: 'https://api-web.nhle.com/v1',
  timeout: 10000,
});
var axiosNhlTeam = axios.create({
  baseURL: 'https://api.nhle.com/stats/rest/en/team',
  timeout: 10000,
});
var axiosNhlStats = axios.create({
  baseURL: 'https://api.nhle.com/stats/rest/en/skater',
  timeout: 10000,
});
var axiosNhlGoalie = axios.create({
  baseURL: 'https://api.nhle.com/stats/rest/en/goalie',
  timeout: 10000,
});

module.exports = { axiosNhl, axiosNhlTeam, axiosNhlStats, axiosNhlGoalie };
